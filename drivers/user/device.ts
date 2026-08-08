import Homey from 'homey';
import type HomeyfinApp from '../../app';
import { ClientSnapshot, ServerHub } from '../../lib/ServerHub';
import type { MediaSegment, NowPlayingItem } from '../../lib/JellyfinClient';

interface UserStore {
  serverId: string;
  userId: string;
  userName: string;
}

interface UserSettings {
  stoppedDebounceMs?: number;
  unwatchedRefreshMinutes?: number;
  volumeCapPercent?: number;
  dailySummaryHour?: number;
}

const POSITION_TICK_MS = 1000;

export default class JellyfinUserDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private store!: UserStore;
  private positionTimer?: NodeJS.Timeout;
  private stoppedDebounceTimer?: NodeJS.Timeout;
  private pendingStop?: { snap: ClientSnapshot; item: NowPlayingItem | undefined };
  private unwatchedTimer?: NodeJS.Timeout;
  private initRetryTimer?: NodeJS.Timeout;
  private hubSwapUnsub?: () => void;
  private albumArtImage?: Homey.Image;
  private posterTokenImage?: Homey.Image;
  private lastArtworkUrl = '';
  private lastProgressFloor?: number;
  private lastRemainingFloor?: number;
  private firedProgressPercents = new Set<number>();
  private firedRemainingMinutes = new Set<number>();
  private lastTickPosition?: number;
  private trackedItemId?: string;
  private segmentItemId?: string;
  private currentSegments: MediaSegment[] = [];
  private firedSegmentKeys = new Set<string>();
  private watchSecondsThisWeek = 0;
  private watchSecondsToday = 0;
  private lastWatchTickDay = -1;
  private lastWatchTickWeek = -1;
  private watchHydrated = false;
  private summaryTimer?: NodeJS.Timeout;

  async onInit(): Promise<void> {
    this.store = this.getStore() as UserStore;
    const app = this.homey.app as HomeyfinApp;

    await this.migrateCapabilities();

    // Rebind when the app tears down / recreates this server's hub (repair,
    // credential change) — otherwise this device stays wired to the dead hub.
    // Guarded because the retry timer re-enters onInit.
    if (!this.hubSwapUnsub) {
      this.hubSwapUnsub = app.onHubSwap(this.store.serverId, (hub) => this.handleHubSwap(hub));
    }

    this.hub = app.getHub(this.store.serverId);
    if (!this.hub) {
      this.setUnavailable('Jellyfin server not connected yet').catch(() => undefined);
      this.initRetryTimer = this.homey.setTimeout(
        () => this.onInit().catch((e) => this.error(e)),
        5_000,
      );
      return;
    }

    await this.setupAlbumArt().catch((err) =>
      this.error('setupAlbumArt failed', (err as Error).message),
    );
    this.registerCapabilityHandlers();
    this.registerHubHandlers();
    this.startPositionTicker();
    this.startUnwatchedRefresh();
    this.scheduleSummary();

    const snap = this.hub.getUserSnapshot(this.store.userId);
    if (snap) await this.applySnapshot(snap);
    else await this.safeSet('client_online', false);
    await this.refreshUserData().catch(() => undefined);

    this.setAvailable().catch(() => undefined);
  }

  async onDeleted(): Promise<void> {
    this.teardown();
    // this.store is only assigned in onInit, which may never have run for this
    // instance — read the store directly so deletion still cleans up.
    const store = this.store ?? (this.getStore() as UserStore | undefined);
    if (store?.userId) this.homey.settings.unset('watch:' + store.userId);
  }

  async onUninit(): Promise<void> {
    // Stop every timer and detach hub listeners on app shutdown/reload.
    this.teardown();
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: UserSettings;
    newSettings: UserSettings;
    changedKeys: string[];
  }): Promise<void> {
    // this.getSettings() still returns the OLD values inside onSettings(), so
    // feed the fresh newSettings straight into the timer restarts.
    if (changedKeys.includes('unwatchedRefreshMinutes')) {
      this.startUnwatchedRefresh(newSettings.unwatchedRefreshMinutes);
    }
    if (changedKeys.includes('dailySummaryHour')) {
      this.scheduleSummary(newSettings.dailySummaryHour);
    }
  }

  private teardown(): void {
    this.detachHubHandlers();
    if (this.hubSwapUnsub) this.hubSwapUnsub();
    this.hubSwapUnsub = undefined;
    if (this.initRetryTimer) this.homey.clearTimeout(this.initRetryTimer);
    if (this.positionTimer) this.homey.clearInterval(this.positionTimer);
    if (this.unwatchedTimer) this.homey.clearInterval(this.unwatchedTimer);
    if (this.stoppedDebounceTimer) this.homey.clearTimeout(this.stoppedDebounceTimer);
    if (this.summaryTimer) this.homey.clearTimeout(this.summaryTimer);
    // Flush the partial interval since the last 30 s persist so an app reload
    // doesn't discard up to ~30 s of counted watch time. Guarded on hydration so
    // an early teardown (hub not ready) can't clobber a good stored value.
    if (this.watchHydrated) this.persistWatch();
    this.initRetryTimer = undefined;
    this.positionTimer = undefined;
    this.unwatchedTimer = undefined;
    this.stoppedDebounceTimer = undefined;
    this.summaryTimer = undefined;
  }

  /**
   * Capabilities added in newer releases (e.g. continue_watching_title,
   * watch_minutes_week) never reach devices paired before that release, so
   * sync any missing ones from the driver manifest.
   */
  private async migrateCapabilities(): Promise<void> {
    const wanted = (this.driver.manifest?.capabilities ?? []) as string[];
    for (const cap of wanted) {
      if (this.hasCapability(cap)) continue;
      await this.addCapability(cap).catch((err: Error) =>
        this.error(`addCapability ${cap} failed`, err.message),
      );
    }
  }

  /** Rewires this device when the hub for its server is recreated or released. */
  private handleHubSwap(hub: ServerHub | undefined): void {
    // Detach BEFORE reassigning this.hub so the old instance loses our listeners.
    this.detachHubHandlers();
    this.hub = hub;
    if (!hub) {
      this.setUnavailable('Jellyfin server not connected yet').catch(() => undefined);
      return;
    }
    this.registerHubHandlers();
    const snap = hub.getUserSnapshot(this.store.userId);
    if (snap) this.applySnapshot(snap).catch((e) => this.error(e));
    else this.safeSet('client_online', false).catch(() => undefined);
    this.setAvailable().catch(() => undefined);
  }

  private detachHubHandlers(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
  }

  private async setupAlbumArt(): Promise<void> {
    const makeImage = async (urlGetter: () => string) => {
      const img = await this.homey.images.createImage();
      (img as any).setStream(async (stream: NodeJS.WritableStream) => {
        const url = urlGetter();
        if (!url) {
          stream.end();
          return;
        }
        const cached = await this.hub?.client.getCachedImage(url);
        if (cached) stream.write(cached.buffer);
        stream.end();
      });
      return img;
    };

    this.albumArtImage = await makeImage(() => this.lastArtworkUrl);
    this.posterTokenImage = await makeImage(() => this.lastArtworkUrl);
    await this.setAlbumArtImage(this.albumArtImage).catch(() => undefined);
  }

  // --- Public accessors used by driver-level flow listeners (multi-device safe) ---

  getHub(): ServerHub | undefined {
    return this.hub;
  }

  getUserId(): string {
    return this.store.userId;
  }

  getSnapshot(): ClientSnapshot | undefined {
    return this.hub?.getUserSnapshot(this.store.userId);
  }

  getVolumeCap(): number {
    const settings = this.getSettings() as UserSettings;
    return Math.min(100, Math.max(0, settings.volumeCapPercent ?? 0));
  }

  // --- Background refresh: unwatched + continue watching ----------------

  private startUnwatchedRefresh(minutesOverride?: number): void {
    if (this.unwatchedTimer) this.homey.clearInterval(this.unwatchedTimer);
    const configured =
      minutesOverride ?? (this.getSettings() as UserSettings).unwatchedRefreshMinutes;
    const minutes = Math.max(1, configured ?? 10);
    this.unwatchedTimer = this.homey.setInterval(
      () => this.refreshUserData().catch(() => undefined),
      minutes * 60_000,
    );
  }

  private async refreshUserData(): Promise<void> {
    if (!this.hub) return;
    try {
      const unwatched = await this.hub.client.getUnplayedCount(this.store.userId, 'Episode');
      await this.safeSet('unwatched_count', unwatched);
    } catch (err) {
      this.error('refresh unwatched failed', (err as Error).message);
    }
    try {
      const resume = await this.hub.client.getResumeItems({
        userId: this.store.userId,
        limit: 1,
      });
      const item = resume.Items?.[0];
      if (item) {
        const label = item.SeriesName
          ? `${item.SeriesName} · S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              item.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${item.Name}`
          : item.Name;
        await this.safeSet('continue_watching_title', label);
      } else {
        await this.safeSet('continue_watching_title', '');
      }
    } catch (err) {
      this.error('refresh resume failed', (err as Error).message);
    }
  }

  // --- Position ticker + progress milestones ----------------------------

  private startPositionTicker(): void {
    if (this.positionTimer) return;
    // Hydrate accumulated watch-time from settings so a restart doesn't reset.
    const stored = this.homey.settings.get(
      'watch:' + this.store.userId,
    ) as { week?: number; day?: number; weekIdx?: number; dayIdx?: number } | undefined;
    if (stored) {
      this.watchSecondsThisWeek = stored.week ?? 0;
      this.watchSecondsToday = stored.day ?? 0;
      this.lastWatchTickWeek = stored.weekIdx ?? -1;
      this.lastWatchTickDay = stored.dayIdx ?? -1;
    }
    this.watchHydrated = true;
    // A restart days into a new day/week must not re-publish last period's total:
    // roll the counters forward against the current clock before publishing.
    this.applyWatchRollover(new Date());
    this.safeSet('watch_minutes_week', Math.floor(this.watchSecondsThisWeek / 60)).catch(() => undefined);

    this.positionTimer = this.homey.setInterval(() => {
      const snap = this.hub?.getUserSnapshot(this.store.userId);
      if (!snap || !snap.online || snap.isPaused || !snap.nowPlaying) return;
      const current = (this.getCapabilityValue('media_position') as number | null) ?? 0;
      const duration = snap.durationSeconds ?? 0;
      const next = duration > 0 ? Math.min(current + 1, duration) : current + 1;
      this.safeSet('media_position', next).catch(() => undefined);
      this.checkProgressTriggers(snap, next, duration);
      this.checkSegmentTriggers(snap, next);
      this.tickWatchTime();
    }, POSITION_TICK_MS);
  }

  private tickWatchTime(): void {
    this.applyWatchRollover(new Date());
    this.watchSecondsToday++;
    this.watchSecondsThisWeek++;

    // Persist + capability update every 30 s to keep settings writes cheap.
    if (this.watchSecondsThisWeek % 30 === 0) {
      this.safeSet('watch_minutes_week', Math.floor(this.watchSecondsThisWeek / 60)).catch(() => undefined);
      this.persistWatch();
    }
  }

  // Encode day/week from the LOCAL calendar date, not by flooring a UTC
  // timestamp: on a DST spring-forward in UTC+0 zones (UK/IE/PT) two adjacent
  // local midnights fall in the same UTC 24h bucket, which would collide and
  // skip the reset. Y*10000+M*100+D is unique per local day (equality is all we
  // need), and the Monday date is unique per week.
  private static dayIndexOf(now: Date): number {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return dayStart.getFullYear() * 10000 + dayStart.getMonth() * 100 + dayStart.getDate();
  }

  private static weekIndexOf(now: Date): number {
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // ISO: Monday=0
    return weekStart.getFullYear() * 10000 + weekStart.getMonth() * 100 + weekStart.getDate();
  }

  /**
   * Resets the day/week counters when the local day/week has rolled over since
   * the last tick — including rollovers that happen with no playback at all (the
   * ticker only runs while playing, so this must also be called from init and
   * before the daily summary fires). Day index is derived from LOCAL midnight so
   * it matches the local wall-clock hour the summary fires on.
   */
  private applyWatchRollover(now: Date): void {
    const dayIdx = JellyfinUserDevice.dayIndexOf(now);
    const weekIdx = JellyfinUserDevice.weekIndexOf(now);

    if (this.lastWatchTickDay !== -1 && this.lastWatchTickDay !== dayIdx) {
      this.watchSecondsToday = 0;
    }
    if (this.lastWatchTickWeek !== -1 && this.lastWatchTickWeek !== weekIdx) {
      this.watchSecondsThisWeek = 0;
      this.safeSet('watch_minutes_week', 0).catch(() => undefined);
    }
    this.lastWatchTickDay = dayIdx;
    this.lastWatchTickWeek = weekIdx;
  }

  private persistWatch(): void {
    this.homey.settings.set('watch:' + this.store.userId, {
      week: this.watchSecondsThisWeek,
      day: this.watchSecondsToday,
      weekIdx: this.lastWatchTickWeek,
      dayIdx: this.lastWatchTickDay,
    });
  }

  private scheduleSummary(hourOverride?: number): void {
    if (this.summaryTimer) this.homey.clearTimeout(this.summaryTimer);
    const configured = hourOverride ?? (this.getSettings() as UserSettings).dailySummaryHour;
    const hour = ((configured ?? 22) + 24) % 24;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    this.summaryTimer = this.homey.setTimeout(() => {
      this.fireDailySummary().catch(() => undefined);
      this.scheduleSummary();
    }, delay);
  }

  private async fireDailySummary(): Promise<void> {
    // The counters only advance while playing, so a zero-playback day would
    // otherwise report yesterday's total — roll them over against the clock
    // first. But with dailySummaryHour=0 the summary fires ON the boundary and
    // the rollover would zero the very totals it is about to report: snapshot
    // the counters first and use them when the boundary this call crossed lies
    // at most 5 minutes in the past (the summary firing at midnight/Monday
    // reports the period that just ended; a rollover after an idle day must
    // still report the fresh, reset counters).
    const now = new Date();
    const dayBefore = this.lastWatchTickDay;
    const weekBefore = this.lastWatchTickWeek;
    const secondsDayBefore = this.watchSecondsToday;
    const secondsWeekBefore = this.watchSecondsThisWeek;
    this.applyWatchRollover(now);
    const justBefore = new Date(now.getTime() - 5 * 60_000);
    const summarizeEndedDay =
      dayBefore !== this.lastWatchTickDay && dayBefore === JellyfinUserDevice.dayIndexOf(justBefore);
    const summarizeEndedWeek =
      weekBefore !== this.lastWatchTickWeek && weekBefore === JellyfinUserDevice.weekIndexOf(justBefore);
    try {
      await this.homey.flow
        .getDeviceTriggerCard('daily_summary')
        .trigger(
          this,
          {
            minutes_today: Math.floor(
              (summarizeEndedDay ? secondsDayBefore : this.watchSecondsToday) / 60,
            ),
            minutes_week: Math.floor(
              (summarizeEndedWeek ? secondsWeekBefore : this.watchSecondsThisWeek) / 60,
            ),
          },
          undefined,
        );
    } catch (err) {
      this.error('daily_summary trigger failed', (err as Error).message);
    }
  }

  private checkProgressTriggers(snap: ClientSnapshot, position: number, duration: number): void {
    if (duration <= 0) return;
    if (snap.nowPlaying?.Id !== this.trackedItemId) {
      this.trackedItemId = snap.nowPlaying?.Id;
      this.lastProgressFloor = undefined;
      this.lastRemainingFloor = undefined;
      this.firedProgressPercents.clear();
      this.firedRemainingMinutes.clear();
      this.lastTickPosition = undefined;
    }

    const percent = Math.floor((position / duration) * 100);
    const remaining = Math.max(0, duration - position);
    const remainingMin = Math.floor(remaining / 60);

    // Only a GENUINE backwards seek re-arms already-fired thresholds: a >10 s
    // jump back is well above the ~2 s sawtooth that applySnapshot's stale
    // client positions cause against the 1 s ticker. Percent thresholds above
    // the new position and remaining-minute thresholds below the new remaining
    // (remaining jumped forward) will be crossed again, so they may fire again.
    if (this.lastTickPosition !== undefined && position < this.lastTickPosition - 10) {
      for (const p of this.firedProgressPercents) {
        if (p > percent) this.firedProgressPercents.delete(p);
      }
      for (const m of this.firedRemainingMinutes) {
        if (m < remainingMin) this.firedRemainingMinutes.delete(m);
      }
    }
    this.lastTickPosition = position;

    this.fireProgressIfNew(percent, snap);
    this.fireRemainingIfNew(remainingMin, remaining, snap);
  }

  private fireProgressIfNew(percent: number, snap: ClientSnapshot): void {
    const prev = this.lastProgressFloor;
    if (prev === percent) return;
    this.lastProgressFloor = percent;
    // The first observation of an item seeds the baseline WITHOUT firing (a
    // resume mid-movie must not replay already-passed thresholds); a backwards
    // seek just lowers the baseline so thresholds can fire again.
    if (prev === undefined || percent < prev) return;
    const item = snap.nowPlaying;
    if (!item) return;
    // Each percent fires at most once per item: the snapshot/ticker sawtooth
    // (~2 s rewinds) silently lowers the crossing baseline, so without this a
    // threshold inside the oscillation window would re-fire on every wave.
    // Narrow the range to the not-yet-fired remainder (only a real backwards
    // seek — see checkProgressTriggers — re-arms fired percents). Bounded at
    // 99 entries, the flow card's max, and cleared on item change.
    let firePrev = prev;
    while (firePrev < percent && this.firedProgressPercents.has(firePrev + 1)) firePrev++;
    if (firePrev === percent) return;
    for (let p = firePrev + 1; p <= percent && p <= 99; p++) this.firedProgressPercents.add(p);
    this.homey.flow
      .getDeviceTriggerCard('progress_percent')
      .trigger(
        this,
        { title: item.Name ?? '', type: item.Type ?? '' },
        // Run listener (user/driver.ts) fires args.percent in (prev, percent].
        { percent, prev: firePrev },
      )
      .catch((err: Error) => this.error('progress trigger failed', err.message));
  }

  private fireRemainingIfNew(remainingMin: number, remainingSeconds: number, snap: ClientSnapshot): void {
    const prev = this.lastRemainingFloor;
    if (prev === remainingMin) return;
    this.lastRemainingFloor = remainingMin;
    // Same crossing semantics as fireProgressIfNew, but the remaining minute
    // DECREASES over time; a backwards seek raises the baseline silently.
    if (prev === undefined || remainingMin > prev) return;
    const item = snap.nowPlaying;
    if (!item) return;
    // Mirror of fireProgressIfNew's once-per-item guard: skip minute values
    // that already fired (the fired ones sit at the top of the range, since
    // larger remaining minutes are crossed first) and narrow the range to the
    // rest. Bounded at 60 entries, the flow card's max, cleared on item change.
    let firePrev = prev;
    while (firePrev > remainingMin && this.firedRemainingMinutes.has(firePrev)) firePrev--;
    if (firePrev === remainingMin) return;
    for (let m = remainingMin + 1; m <= firePrev && m <= 60; m++) this.firedRemainingMinutes.add(m);
    this.homey.flow
      .getDeviceTriggerCard('minutes_before_end')
      .trigger(
        this,
        {
          title: item.Name ?? '',
          type: item.Type ?? '',
          series: item.SeriesName ?? '',
          remaining_seconds: remainingSeconds,
        },
        // Run listener (user/driver.ts) fires args.minutes in (minutes, prev].
        { minutes: remainingMin, prev: firePrev },
      )
      .catch((err: Error) => this.error('minutes_before_end trigger failed', err.message));
  }

  // --- Media segments (intro/outro triggers) ------------------------------

  /**
   * Fires intro_started / outro_started when the position enters an
   * Intro/Outro media segment of the current item. Segments are fetched once
   * per item (through the hub's LRU cache, fire-and-forget) and ONLY the
   * current item's Intro/Outro segments are kept, so this holds no growing
   * state. A set of fired segment keys — analogous to the progress-milestone
   * baselines — guarantees each segment triggers at most once per item; the
   * first tick observed inside a segment is the entry tick (the ticker runs
   * every second), so a seek back into an already-fired segment stays silent.
   */
  private checkSegmentTriggers(snap: ClientSnapshot, position: number): void {
    const itemId = snap.nowPlaying?.Id;
    if (!itemId) return;
    if (itemId !== this.segmentItemId) {
      this.segmentItemId = itemId;
      this.currentSegments = [];
      this.firedSegmentKeys.clear();
      this.hub?.getMediaSegments(itemId)
        .then((segments) => {
          // The item may have changed while the request was in flight.
          if (this.segmentItemId !== itemId) return;
          this.currentSegments = segments.filter(
            (s) => (s.type === 'Intro' || s.type === 'Outro') && s.endSeconds > s.startSeconds,
          );
        })
        .catch((err: Error) => {
          this.error('getMediaSegments failed', err.message);
          // A transient failure (network, 5xx) must not leave intro/outro dead
          // for the whole item: clear the tracked id so the next tick fetches
          // again. Cheap — the hub's LRU caches negative results, so an item
          // that genuinely has no segments won't hammer the server.
          if (this.segmentItemId === itemId) this.segmentItemId = undefined;
        });
      return;
    }
    for (const seg of this.currentSegments) {
      if (position < seg.startSeconds || position >= seg.endSeconds) continue;
      const key = `${seg.type}:${seg.startSeconds}`;
      if (this.firedSegmentKeys.has(key)) continue;
      this.firedSegmentKeys.add(key);
      const cardId = seg.type === 'Intro' ? 'intro_started' : 'outro_started';
      const item = snap.nowPlaying;
      if (!item) return;
      this.homey.flow
        .getDeviceTriggerCard(cardId)
        .trigger(
          this,
          {
            title: item.Name ?? '',
            type: item.Type ?? '',
            series: item.SeriesName ?? '',
            season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
            episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
          },
          undefined,
        )
        .catch((err: Error) => this.error(`${cardId} trigger failed`, err.message));
    }
  }

  // --- Hub event wiring --------------------------------------------------

  private registerHubHandlers(): void {
    // Detach-first so a hub swap or init retry can never stack duplicate
    // listeners; the local `hub` binding keeps the off() calls aimed at the
    // instance the listeners were actually attached to.
    this.detachHubHandlers();
    const hub = this.hub;
    if (!hub) return;
    const userId = this.store.userId;

    const onUpdate = (snap: ClientSnapshot) =>
      this.applySnapshot(snap).catch((e) => this.error(e));
    const onStarted = (snap: ClientSnapshot, item: NowPlayingItem) => {
      this.cancelPendingStop();
      this.fireMediaTrigger('playback_started', item, snap);
    };
    const onPaused = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_paused', item, snap);
    const onResumed = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_resumed', item, snap);
    const onStopped = (snap: ClientSnapshot, item: NowPlayingItem | undefined) =>
      this.scheduleStop(snap, item);
    const onChanged = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('now_playing_changed', item, snap);

    const ev = (suffix: string) => `user:${userId}:${suffix}`;
    hub.on(ev('update'), onUpdate);
    hub.on(ev('playback_started'), onStarted);
    hub.on(ev('playback_paused'), onPaused);
    hub.on(ev('playback_resumed'), onResumed);
    hub.on(ev('playback_stopped'), onStopped);
    hub.on(ev('now_playing_changed'), onChanged);

    this.offCallbacks.push(
      () => hub.off(ev('update'), onUpdate),
      () => hub.off(ev('playback_started'), onStarted),
      () => hub.off(ev('playback_paused'), onPaused),
      () => hub.off(ev('playback_resumed'), onResumed),
      () => hub.off(ev('playback_stopped'), onStopped),
      () => hub.off(ev('now_playing_changed'), onChanged),
    );
  }

  private scheduleStop(snap: ClientSnapshot, item: NowPlayingItem | undefined): void {
    const settings = this.getSettings() as UserSettings;
    const delay = Math.max(0, settings.stoppedDebounceMs ?? 4000);
    this.cancelPendingStop();
    this.pendingStop = { snap, item };
    if (delay === 0) {
      this.firePendingStop();
      return;
    }
    this.stoppedDebounceTimer = this.homey.setTimeout(() => this.firePendingStop(), delay);
  }

  private cancelPendingStop(): void {
    if (this.stoppedDebounceTimer) {
      this.homey.clearTimeout(this.stoppedDebounceTimer);
      this.stoppedDebounceTimer = undefined;
    }
    this.pendingStop = undefined;
  }

  private firePendingStop(): void {
    if (!this.pendingStop) return;
    const { snap, item } = this.pendingStop;
    this.pendingStop = undefined;
    this.stoppedDebounceTimer = undefined;
    const current = this.hub?.getUserSnapshot(this.store.userId);
    if (current?.nowPlaying) return;
    if (item) this.fireMediaTrigger('playback_stopped', item, snap);
  }

  // --- Capability listeners (Homey → Jellyfin) ---------------------------

  private registerCapabilityHandlers(): void {
    this.registerCapabilityListener('speaker_playing', (value: boolean) =>
      this.control((sid) => this.hub!.client.sendPlaystate(sid, value ? 'Unpause' : 'Pause')),
    );
    this.registerCapabilityListener('speaker_next', () =>
      this.control((sid) => this.hub!.client.sendPlaystate(sid, 'NextTrack')),
    );
    this.registerCapabilityListener('speaker_prev', () =>
      this.control((sid) => this.hub!.client.sendPlaystate(sid, 'PreviousTrack')),
    );
    this.registerCapabilityListener('volume_set', (value: number) => {
      const cap = Math.min(100, Math.max(0, (this.getSettings() as UserSettings).volumeCapPercent ?? 0));
      let volume = Math.round(Math.max(0, Math.min(1, value)) * 100);
      if (cap > 0 && volume > cap) volume = cap;
      return this.control((sid) => this.hub!.client.sendCommand(sid, 'SetVolume', { Volume: volume }));
    });
    this.registerCapabilityListener('volume_mute', (value: boolean) =>
      this.control((sid) => this.hub!.client.sendCommand(sid, value ? 'Mute' : 'Unmute')),
    );
  }

  /**
   * Runs a remote-control command against the user's current session. If it
   * fails (e.g. the session id changed underneath us), it invalidates the live
   * cache and retries once with a freshly fetched session before surfacing the
   * error to Homey.
   */
  private async control(action: (sessionId: string) => Promise<void>): Promise<void> {
    try {
      await action(await this.requireSessionId());
      return;
    } catch (first) {
      this.error('control failed, retrying with fresh session:', (first as Error).message);
      this.hub?.invalidateSessionCaches();
    }
    await action(await this.requireSessionId());
  }

  async requireSessionId(): Promise<string> {
    const snap = await this.liveUserSnapshot();
    if (!snap || !snap.online || !snap.sessionId) {
      throw new Error('User has no active Jellyfin session right now');
    }
    return snap.sessionId;
  }

  /**
   * Resolves the user's current session with a live server round-trip so
   * remote-control commands never target a stale session id; falls back to the
   * cached snapshot if the lookup fails.
   */
  private async liveUserSnapshot(): Promise<ClientSnapshot | undefined> {
    if (!this.hub) return undefined;
    try {
      const live = await this.hub.getLiveUserSession(this.store.userId);
      if (live) return live;
    } catch (err) {
      this.error('live session lookup failed', (err as Error).message);
    }
    return this.hub.getUserSnapshot(this.store.userId);
  }

  currentSession(): { sessionId: string; snap: ClientSnapshot } | undefined {
    const snap = this.hub?.getUserSnapshot(this.store.userId);
    if (!snap || !snap.online || !snap.sessionId) return undefined;
    return { sessionId: snap.sessionId, snap };
  }

  /**
   * Like currentSession() but forces a live /Sessions lookup, so Flow actions
   * don't misfire against a cold cache right after an app restart (before the
   * first socket frame) or a stale session id after the browser reconnected.
   */
  async liveSession(): Promise<{ sessionId: string; snap: ClientSnapshot } | undefined> {
    const snap = await this.liveUserSnapshot();
    if (!snap || !snap.online || !snap.sessionId) return undefined;
    return { sessionId: snap.sessionId, snap };
  }


  listStreams(kind: 'Audio' | 'Subtitle'): Array<{ name: string; id: string }> {
    const snap = this.hub?.getUserSnapshot(this.store.userId);
    const streams = snap?.nowPlaying?.MediaStreams?.filter((s) => s.Type === kind) ?? [];
    return streams.map((s) => ({
      name: s.DisplayTitle ?? `${s.Language ?? '???'} (${s.Codec ?? ''})`.trim(),
      id: String(s.Index),
    }));
  }

  // --- Snapshot application ----------------------------------------------

  private async applySnapshot(snap: ClientSnapshot): Promise<void> {
    await this.safeSet('client_online', snap.online);
    await this.safeSet('is_transcoding', snap.isTranscoding);

    const playing = Boolean(snap.nowPlaying && !snap.isPaused);
    await this.safeSet('speaker_playing', playing);

    if (typeof snap.volumeLevel === 'number') {
      await this.safeSet('volume_set', Math.max(0, Math.min(1, snap.volumeLevel / 100)));
    }
    await this.safeSet('volume_mute', snap.isMuted);

    const item = snap.nowPlaying;
    if (item) {
      await this.safeSet('media_title', this.titleFor(item));
      await this.safeSet('media_subtitle', this.subtitleFor(item));
      await this.safeSet('speaker_track', item.Name ?? '');
      await this.safeSet('speaker_artist', item.SeriesName ?? item.Type ?? '');
      await this.safeSet(
        'speaker_album',
        item.SeasonName ?? (item.ProductionYear ? String(item.ProductionYear) : ''),
      );
    } else {
      await this.safeSet('media_title', '');
      await this.safeSet('media_subtitle', '');
      await this.safeSet('speaker_track', '');
      await this.safeSet('speaker_artist', '');
      await this.safeSet('speaker_album', '');
    }

    if (typeof snap.positionSeconds === 'number') {
      await this.safeSet('media_position', snap.positionSeconds);
    }
    await this.safeSet('media_duration', snap.durationSeconds ?? 0);

    await this.updateAlbumArt(snap.posterUrl ?? '');
  }

  private async updateAlbumArt(url: string): Promise<void> {
    if (url === this.lastArtworkUrl) return;
    this.lastArtworkUrl = url;
    try {
      if (this.albumArtImage) await this.albumArtImage.update();
      if (this.posterTokenImage) await this.posterTokenImage.update();
    } catch (err) {
      this.error('updateAlbumArt failed', (err as Error).message);
    }
  }

  private titleFor(item: NowPlayingItem): string {
    if (item.Type === 'Episode' && item.SeriesName) return item.SeriesName;
    return item.Name ?? '';
  }

  private subtitleFor(item: NowPlayingItem): string {
    if (item.Type === 'Episode') {
      const s = item.ParentIndexNumber ?? 0;
      const e = item.IndexNumber ?? 0;
      return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')} · ${item.Name ?? ''}`;
    }
    if (item.Type === 'Movie' && item.ProductionYear) return `${item.ProductionYear}`;
    return item.Type ?? '';
  }

  private async fireMediaTrigger(
    cardId: string,
    item: NowPlayingItem,
    snap: ClientSnapshot,
  ): Promise<void> {
    const tokens: Record<string, unknown> = {
      title: item.Name ?? '',
      type: item.Type ?? '',
      series: item.SeriesName ?? '',
      season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
      episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
      runtime: snap.durationSeconds ?? 0,
      user: snap.userName ?? this.store.userName,
      client: snap.clientName ?? '',
      device: snap.deviceName ?? '',
    };
    if (cardId === 'playback_started') {
      // The token is declared `image` in the manifest, which Homey requires.
      // Always provide a value; setupAlbumArt creates a permanent stub even
      // before any URL is set, so this is safe.
      if (this.posterTokenImage) tokens.poster = this.posterTokenImage;
    }
    try {
      await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, tokens as never, undefined);
    } catch (err) {
      this.error(`${cardId} trigger failed`, (err as Error).message);
    }
  }

  private async safeSet(capability: string, value: unknown): Promise<void> {
    try {
      if (!this.hasCapability(capability)) return;
      // Skip redundant writes: on a steady stream only the position changes, so
      // this avoids ~14 needless setCapabilityValue calls per socket frame per
      // device (each of which also hits Insights/Flow) — the difference between
      // "fine" and "CPU limit" once many users are streaming.
      if (this.getCapabilityValue(capability) === value) return;
      await this.setCapabilityValue(capability, value as never);
    } catch (err) {
      this.error(`setCapabilityValue ${capability} failed`, (err as Error).message);
    }
  }
}

module.exports = JellyfinUserDevice;
