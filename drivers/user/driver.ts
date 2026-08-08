import Homey from 'homey';
import type HomeyfinApp from '../../app';
import type { ServerHub, ClientSnapshot } from '../../lib/ServerHub';

interface ServerOption {
  id: string;
  name: string;
  baseUrl: string;
}

interface UserListItem {
  Id: string;
  Name: string;
  IsAdministrator?: boolean;
  alreadyPaired?: boolean;
}

type JellyfinUserDevice = Homey.Device & {
  getHub(): ServerHub | undefined;
  getUserId(): string;
  getSnapshot(): ClientSnapshot | undefined;
  requireSessionId(): Promise<string>;
  currentSession(): { sessionId: string; snap: ClientSnapshot } | undefined;
  liveSession(): Promise<{ sessionId: string; snap: ClientSnapshot } | undefined>;
  listStreams(kind: 'Audio' | 'Subtitle'): Array<{ name: string; id: string }>;
  getVolumeCap(): number;
};

// Segment types the skip_segment action jumps over. Only these are considered
// "skippable"; unknown/preview types are ignored.
const SKIPPABLE_SEGMENT_TYPES = new Set(['Intro', 'Outro', 'Recap', 'Commercial']);
// Hard cap on how many sessions stop_user_sessions addresses in one run so a
// runaway session list can never turn into an unbounded command burst.
const MAX_STOPPED_SESSIONS = 20;
// How many playlist/collection children play_playlist fetches from the server
// at most, and how many of them one Play request may carry: the ids travel in
// the query string, which tops out around ~230 GUIDs.
const MAX_PLAYLIST_FETCH = 300;
const MAX_PLAYLIST_PLAY = 200;

interface UserListDevice {
  name: string;
  data: { id: string };
  store: {
    serverId: string;
    userId: string;
    userName: string;
  };
}

export default class JellyfinUserDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('User driver init');
    this.registerFlowHandlers();
  }

  /** Throws a friendly message if the device's hub isn't ready yet. */
  private static requireHub(device: JellyfinUserDevice): ServerHub {
    const hub = device.getHub();
    if (!hub) throw new Error('Jellyfin server not connected yet');
    return hub;
  }

  /**
   * Flow cards are app-wide singletons. registerRunListener replaces the
   * previous handler, so registering per-device would silently break
   * multi-user setups (every action would target the most-recently
   * initialised device). Listeners are bound here, once, and resolve the
   * concrete device via args.device.
   */
  private registerFlowHandlers(): void {
    // Crossing semantics: the device fires once per floor change with the
    // previous floor in the state, so a threshold is matched exactly once even
    // when a seek jumps multiple percents/minutes at a time.
    this.homey.flow
      .getDeviceTriggerCard('progress_percent')
      .registerRunListener(
        async (args: { percent: number }, state: { percent: number; prev: number }) =>
          state.prev < args.percent && args.percent <= state.percent,
      );

    this.homey.flow
      .getDeviceTriggerCard('minutes_before_end')
      .registerRunListener(
        // Remaining DECREASES: a threshold of N minutes fires when the floored
        // remaining drops from N to N-1 — i.e. when exactly N minutes are left,
        // not a minute early while N minutes and change still remain.
        async (args: { minutes: number }, state: { minutes: number; prev: number }) =>
          state.minutes < args.minutes && args.minutes <= state.prev,
      );

    this.homey.flow
      .getConditionCard('is_playing')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const snap = args.device.getSnapshot();
        return Boolean(snap?.nowPlaying && !snap.isPaused);
      });

    this.homey.flow
      .getConditionCard('media_type_is')
      .registerRunListener(
        async (args: { device: JellyfinUserDevice; media_type: string }) => {
          return args.device.getSnapshot()?.nowPlaying?.Type === args.media_type;
        },
      );

    this.homey.flow
      .getConditionCard('playing_on_client')
      .registerRunListener(async (args: { device: JellyfinUserDevice; client: string }) => {
        const query = (args.client ?? '').trim().toLowerCase();
        if (!query) return false;
        const snap = args.device.getSnapshot();
        if (!snap?.online) return false;
        const haystack = `${snap.clientName ?? ''} ${snap.deviceName ?? ''}`.toLowerCase();
        return haystack.includes(query);
      });

    this.homey.flow
      .getConditionCard('is_transcoding')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        return Boolean(args.device.getSnapshot()?.isTranscoding);
      });

    this.homey.flow
      .getActionCard('send_message')
      .registerRunListener(
        async (args: {
          device: JellyfinUserDevice;
          header?: string;
          text: string;
          timeout_ms?: number;
        }) => {
          const sessionId = await args.device.requireSessionId();
          await JellyfinUserDriver.requireHub(args.device).client.sendMessage(
            sessionId,
            args.header && args.header.length > 0 ? args.header : 'Homey',
            args.text ?? '',
            typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 5000,
          );
        },
      );

    this.homey.flow
      .getActionCard('seek_to')
      .registerRunListener(async (args: { device: JellyfinUserDevice; seconds: number }) => {
        const sessionId = await args.device.requireSessionId();
        await JellyfinUserDriver.requireHub(args.device).client.seekToSeconds(sessionId, args.seconds);
      });

    this.homey.flow
      .getActionCard('seek_relative')
      .registerRunListener(async (args: { device: JellyfinUserDevice; seconds: number }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const current = session.snap.positionSeconds ?? 0;
        const duration = session.snap.durationSeconds ?? 0;
        const target = Math.max(
          0,
          duration > 0
            ? Math.min(duration, current + (args.seconds || 0))
            : current + args.seconds,
        );
        await JellyfinUserDriver.requireHub(args.device).client.seekToSeconds(session.sessionId, target);
      });

    const playItem = this.homey.flow.getActionCard('play_item');
    playItem.registerRunListener(
      async (args: { device: JellyfinUserDevice; item: { id?: string } }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        if (!args.item?.id) throw new Error('No item picked');
        await JellyfinUserDriver.requireHub(args.device).client.playItemsOnSession(session.sessionId, [args.item.id]);
      },
    );
    playItem.registerArgumentAutocompleteListener('item', async (query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      const hub = dev?.getHub();
      if (!hub || !query || query.length < 2) return [];
      const res = await hub.client
        .searchItems({
          userId: dev!.getUserId(),
          searchTerm: query,
          limit: 20,
          includeItemTypes: 'Movie,Episode,Series',
        })
        .catch(() => ({ Items: [] }));
      return res.Items.map((i) => ({
        name: i.SeriesName
          ? `${i.SeriesName} · S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              i.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${i.Name}`
          : i.ProductionYear
            ? `${i.Name} (${i.ProductionYear})`
            : i.Name,
        id: i.Id,
      }));
    });

    const randomAction = this.homey.flow.getActionCard('play_random');
    randomAction.registerRunListener(
      async (args: {
        device: JellyfinUserDevice;
        item_type: 'Movie' | 'Episode';
        genre?: { id?: string; name?: string };
      }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const res = await JellyfinUserDriver.requireHub(args.device).client.getRandomItems({
          userId: args.device.getUserId(),
          limit: 1,
          includeItemTypes: args.item_type,
          genres: args.genre?.name && args.genre.id !== 'any' ? args.genre.name : undefined,
        });
        const item = res.Items?.[0];
        if (!item) throw new Error('No item found for these filters');
        await JellyfinUserDriver.requireHub(args.device).client.playItemsOnSession(session.sessionId, [item.Id]);
        return { title: item.Name };
      },
    );
    randomAction.registerArgumentAutocompleteListener(
      'genre',
      async (query, args: { device?: JellyfinUserDevice; item_type?: string }) => {
        const dev = args.device;
        const hub = dev?.getHub();
        if (!hub) return [{ name: 'Any', id: 'any' }];
        const res = await hub.client
          .getGenres({ userId: dev!.getUserId(), includeItemTypes: args.item_type })
          .catch(() => ({ Items: [] as { Id: string; Name: string }[] }));
        const all = [
          { name: 'Any', id: 'any' },
          ...res.Items.map((g) => ({ name: g.Name, id: g.Id })),
        ];
        if (!query) return all;
        const q = query.toLowerCase();
        return all.filter((g) => g.name.toLowerCase().includes(q));
      },
    );

    this.homey.flow
      .getActionCard('continue_watching')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const res = await JellyfinUserDriver.requireHub(args.device).client.getResumeItems({
          userId: args.device.getUserId(),
          limit: 1,
        });
        const item = res.Items?.[0];
        if (!item) throw new Error('Nothing to continue');
        const startTicks =
          typeof item.UserData?.PlaybackPositionTicks === 'number'
            ? item.UserData.PlaybackPositionTicks
            : undefined;
        await JellyfinUserDriver.requireHub(args.device).client.playItemsOnSession(session.sessionId, [item.Id], {
          startPositionTicks: startTicks,
        });
        return { title: item.Name };
      });

    const queueAdd = this.homey.flow.getActionCard('queue_add');
    queueAdd.registerRunListener(
      async (args: {
        device: JellyfinUserDevice;
        item: { id?: string };
        where: 'PlayNext' | 'PlayLast';
      }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        if (!args.item?.id) throw new Error('No item picked');
        await JellyfinUserDriver.requireHub(args.device).client.playItemsOnSession(
          session.sessionId,
          [args.item.id],
          { playCommand: args.where ?? 'PlayNext' },
        );
      },
    );
    queueAdd.registerArgumentAutocompleteListener('item', async (query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      const hub = dev?.getHub();
      if (!hub || !query || query.length < 2) return [];
      const res = await hub.client
        .searchItems({
          userId: dev!.getUserId(),
          searchTerm: query,
          limit: 20,
          includeItemTypes: 'Movie,Episode,Series,Audio',
        })
        .catch(() => ({ Items: [] }));
      return res.Items.map((i) => ({
        name: i.SeriesName
          ? `${i.SeriesName} · S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              i.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${i.Name}`
          : i.ProductionYear
            ? `${i.Name} (${i.ProductionYear})`
            : i.Name,
        id: i.Id,
      }));
    });

    const playPlaylist = this.homey.flow.getActionCard('play_playlist');
    playPlaylist.registerRunListener(
      async (args: {
        device: JellyfinUserDevice;
        playlist: { id?: string };
        mode: 'play' | 'shuffle';
      }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        if (!args.playlist?.id) throw new Error('No playlist or collection picked');
        const client = JellyfinUserDriver.requireHub(args.device).client;
        const ids = await client.getPlayableChildIds(args.playlist.id, MAX_PLAYLIST_FETCH);
        if (ids.length === 0) throw new Error('Playlist or collection has no playable items');
        if (args.mode === 'shuffle') {
          // Fisher–Yates shuffle
          for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
          }
        }
        // Cap AFTER the shuffle so shuffle mode still samples the whole list.
        if (ids.length > MAX_PLAYLIST_PLAY) {
          this.log(`play_playlist: capping ${ids.length} items to ${MAX_PLAYLIST_PLAY}`);
          ids.length = MAX_PLAYLIST_PLAY;
        }
        await client.playItemsOnSession(session.sessionId, ids);
      },
    );
    playPlaylist.registerArgumentAutocompleteListener('playlist', async (query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      const hub = dev?.getHub();
      if (!hub) return [];
      const items = await hub.client.getPlaylistsAndCollections().catch(() => []);
      const all = items.map((i) => ({ name: i.Name, id: i.Id }));
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((i) => i.name.toLowerCase().includes(q));
    });

    this.homey.flow
      .getActionCard('navigate')
      .registerRunListener(
        async (args: {
          device: JellyfinUserDevice;
          command: 'GoHome' | 'Back' | 'Select' | 'MoveUp' | 'MoveDown' | 'MoveLeft' | 'MoveRight';
        }) => {
          const sessionId = await args.device.requireSessionId();
          await JellyfinUserDriver.requireHub(args.device).client.sendCommand(sessionId, args.command);
        },
      );

    const displayItem = this.homey.flow.getActionCard('display_item');
    displayItem.registerRunListener(
      async (args: {
        device: JellyfinUserDevice;
        item: { id?: string; name?: string; type?: string; itemName?: string };
      }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        if (!args.item?.id) throw new Error('No item picked');
        await JellyfinUserDriver.requireHub(args.device).client.displayContent(session.sessionId, {
          id: args.item.id,
          name: args.item.itemName ?? args.item.name,
          type: args.item.type,
        });
      },
    );
    displayItem.registerArgumentAutocompleteListener('item', async (query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      const hub = dev?.getHub();
      if (!hub || !query || query.length < 2) return [];
      const res = await hub.client
        .searchItems({
          userId: dev!.getUserId(),
          searchTerm: query,
          limit: 20,
          includeItemTypes: 'Movie,Episode,Series',
        })
        .catch(() => ({ Items: [] }));
      return res.Items.map((i) => ({
        name: i.SeriesName
          ? `${i.SeriesName} · S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              i.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${i.Name}`
          : i.ProductionYear
            ? `${i.Name} (${i.ProductionYear})`
            : i.Name,
        id: i.Id,
        // Extra fields ride along in the saved autocomplete result so the run
        // listener can hand DisplayContent the real item name/type.
        type: i.Type,
        itemName: i.Name,
      }));
    });

    this.homey.flow
      .getActionCard('queue_clear')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const sessionId = await args.device.requireSessionId();
        await JellyfinUserDriver.requireHub(args.device).client.clearSessionQueue(sessionId);
      });

    this.homey.flow.getActionCard('skip_chapter').registerRunListener(
      async (args: { device: JellyfinUserDevice; direction: 'next' | 'prev' }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const item = session.snap.nowPlaying;
        if (!item?.Id) throw new Error('Nothing is currently playing');
        const full = await JellyfinUserDriver.requireHub(args.device).client.getItem(args.device.getUserId(), item.Id, 'Chapters');
        const chapters = (full.Chapters ?? []).map((c) => c.StartPositionTicks);
        if (chapters.length === 0) throw new Error('This item has no chapter data');
        const positionTicks = (session.snap.positionSeconds ?? 0) * 10_000_000;
        let target: number | undefined;
        if (args.direction === 'next') {
          target = chapters.find((t) => t > positionTicks + 1_000_000);
        } else {
          const grace = 5 * 10_000_000;
          for (let i = chapters.length - 1; i >= 0; i--) {
            if (chapters[i] < positionTicks - grace) {
              target = chapters[i];
              break;
            }
          }
          if (target === undefined && chapters.length > 0) target = chapters[0];
        }
        if (target === undefined) throw new Error('No chapter in that direction');
        await JellyfinUserDriver.requireHub(args.device).client.seekToSeconds(session.sessionId, target / 10_000_000);
      },
    );

    const audioAction = this.homey.flow.getActionCard('set_audio_track');
    audioAction.registerRunListener(
      async (args: { device: JellyfinUserDevice; track: { id?: string } }) => {
        const sessionId = await args.device.requireSessionId();
        const idx = Number(args.track?.id);
        if (!Number.isFinite(idx)) throw new Error('Pick a track');
        await JellyfinUserDriver.requireHub(args.device).client.sendCommand(sessionId, 'SetAudioStreamIndex', { Index: idx });
      },
    );
    audioAction.registerArgumentAutocompleteListener('track', async (_query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      return dev ? dev.listStreams('Audio') : [];
    });

    const subAction = this.homey.flow.getActionCard('set_subtitle_track');
    subAction.registerRunListener(
      async (args: { device: JellyfinUserDevice; track: { id?: string } }) => {
        const sessionId = await args.device.requireSessionId();
        const idx = Number(args.track?.id);
        await JellyfinUserDriver.requireHub(args.device).client.sendCommand(sessionId, 'SetSubtitleStreamIndex', { Index: idx });
      },
    );
    subAction.registerArgumentAutocompleteListener('track', async (_query, args) => {
      const dev = (args as { device?: JellyfinUserDevice }).device;
      const items = dev ? dev.listStreams('Subtitle') : [];
      return [{ name: 'Off', id: '-1' }, ...items];
    });

    this.homey.flow
      .getActionCard('mark_watched')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const id = args.device.getSnapshot()?.nowPlaying?.Id;
        if (!id) throw new Error('Nothing is currently playing');
        await JellyfinUserDriver.requireHub(args.device).client.setPlayed(args.device.getUserId(), id, true);
      });

    this.homey.flow
      .getActionCard('toggle_favorite')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const id = args.device.getSnapshot()?.nowPlaying?.Id;
        if (!id) throw new Error('Nothing is currently playing');
        const userId = args.device.getUserId();
        const full = await JellyfinUserDriver.requireHub(args.device).client.getItem(userId, id, 'UserData');
        const fav = full.UserData?.IsFavorite === true;
        await JellyfinUserDriver.requireHub(args.device).client.setFavorite(userId, id, !fav);
      });

    this.homey.flow
      .getActionCard('bookmark')
      .registerRunListener(
        async (args: { device: JellyfinUserDevice; playlist_name?: string }) => {
          const id = args.device.getSnapshot()?.nowPlaying?.Id;
          const name = args.device.getSnapshot()?.nowPlaying?.Name ?? '';
          if (!id) throw new Error('Nothing is currently playing');
          const userId = args.device.getUserId();
          const playlistName = args.playlist_name?.trim() || 'Homey Watchlist';
          const all = await JellyfinUserDriver.requireHub(args.device).client.getPlaylists(userId);
          const existing = all.Items.find(
            (p) => p.Name?.toLowerCase() === playlistName.toLowerCase(),
          );
          let playlistId = existing?.Id;
          if (!playlistId) {
            playlistId = await JellyfinUserDriver.requireHub(args.device).client.createPlaylist({ userId, name: playlistName, itemIds: [id] });
          } else {
            await JellyfinUserDriver.requireHub(args.device).client.addToPlaylist(playlistId, userId, [id]);
          }
          return { title: name };
        },
      );

    this.homey.flow
      .getActionCard('skip_segment')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const session = await args.device.liveSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const item = session.snap.nowPlaying;
        if (!item?.Id) throw new Error('Nothing is currently playing');
        const hub = JellyfinUserDriver.requireHub(args.device);
        const segments = await hub.getMediaSegments(item.Id);
        const position = session.snap.positionSeconds ?? 0;
        const active = segments.find(
          (s) =>
            SKIPPABLE_SEGMENT_TYPES.has(s.type) &&
            s.startSeconds <= position &&
            position < s.endSeconds,
        );
        // Not being inside a segment is a valid state — treat it as a no-op so
        // the card is safe to fire unconditionally during playback.
        if (!active) return;
        await hub.client.seekToSeconds(session.sessionId, active.endSeconds);
      });

    this.homey.flow
      .getActionCard('set_user_enabled')
      .registerRunListener(
        async (args: { device: JellyfinUserDevice; mode: 'enable' | 'disable' }) => {
          await JellyfinUserDriver.requireHub(args.device).client.setUserDisabled(
            args.device.getUserId(),
            args.mode === 'disable',
          );
        },
      );

    this.homey.flow
      .getActionCard('stop_user_sessions')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) => {
        const hub = JellyfinUserDriver.requireHub(args.device);
        const userId = args.device.getUserId();
        const sessions = (await hub.client.getSessions())
          .filter((s) => s.UserId === userId && s.NowPlayingItem)
          .slice(0, MAX_STOPPED_SESSIONS);
        for (const session of sessions) {
          // One unreachable client must not keep the user's other sessions
          // playing — log per-session failures and carry on.
          await hub.client
            .sendPlaystate(session.Id, 'Stop')
            .catch((err: Error) => this.error('stop session failed', session.Id, err.message));
        }
      });

    this.homey.flow
      .getConditionCard('user_disabled')
      .registerRunListener(async (args: { device: JellyfinUserDevice }) =>
        JellyfinUserDriver.requireHub(args.device).client.getUserDisabled(args.device.getUserId()),
      );
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;

    session.setHandler('list_servers', async (): Promise<ServerOption[]> => {
      const serverDriver = this.homey.drivers.getDriver('server');
      return serverDriver.getDevices().map((d: any) => {
        const store = d.getStore() as { baseUrl: string };
        const id = d.getData().id.replace(/^server:/, '');
        return { id, name: d.getName(), baseUrl: store.baseUrl };
      });
    });

    session.setHandler('fetch_users', async ({ serverId }: { serverId: string }): Promise<UserListItem[]> => {
      if (!serverId) throw new Error('No server selected');
      const hub = app.getHub(serverId);
      if (!hub) throw new Error('Server hub not initialised yet. Try again in a moment.');

      const users = await hub.client.getUsers();
      const existing = new Set(this.getDevices().map((d: any) => d.getData().id as string));
      return users.map((u) => ({
        Id: u.Id,
        Name: u.Name,
        IsAdministrator: u.IsAdministrator,
        alreadyPaired: existing.has(`${serverId}:${u.Id}`),
      }));
    });

    session.setHandler(
      'add_user',
      async ({ serverId, userId }: { serverId: string; userId: string }): Promise<UserListDevice> => {
        if (!serverId) throw new Error('No server selected');
        const hub = app.getHub(serverId);
        if (!hub) throw new Error('Server hub not initialised yet.');

        const users = await hub.client.getUsers();
        const user = users.find((u) => u.Id === userId);
        if (!user) throw new Error('User no longer present on server');

        return {
          name: `Jellyfin · ${user.Name}`,
          data: { id: `${serverId}:${user.Id}` },
          store: {
            serverId,
            userId: user.Id,
            userName: user.Name,
          },
        };
      },
    );
  }
}

module.exports = JellyfinUserDriver;
