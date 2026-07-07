Mediabediening voor Jellyfin — Onofficiële Jellyfin-integratie voor Homey

Niet gelieerd aan of onderschreven door de Jellyfin Foundation. Jellyfin is een
handelsmerk van de Jellyfin Foundation; dit is een onofficiële client van
derden.

WAT HET DOET

Bedien je Jellyfin-mediaserver en zijn gebruikers vanuit Homey. Elk
Homey-apparaat staat voor één Jellyfin-gebruiker, en afspeelopdrachten volgen de
gebruiker automatisch naar de client waarop hij op dat moment kijkt — 's avonds
de woonkamer-tv, onderweg de telefoon.

APPARATEN

Jellyfin-server — bibliotheektellers (films, series, afleveringen), laatst
toegevoegde titel, actieve streams en transcodes, verbindingsstatus, uptime en
scanstatus.

Jellyfin-gebruiker — now-playing-titel en details, positie en duur, volume,
albumhoes, aantal ongekeken afleveringen, doorkijken-titel, wekelijkse
kijkminuten, online- en transcodingstatus.

FLOWS

Triggers: afspelen gestart, gepauzeerd, hervat, gestopt en gewijzigd;
voortgangsmijlpalen en minuten voor het einde; nieuw bibliotheekitem (met
poster); bibliotheekscan voltooid; gebruiker aangemeld; transcoding gestart of
gestopt; actieve streams gewijzigd; server verbonden of verbroken; dagelijkse
samenvatting.

Voorwaarden: speelt af, mediatype is, transcodeert, actieve streams boven N.

Acties: afspelen en pauzeren, zoeken, hoofdstuk overslaan, audio- en
ondertitelspoor instellen, aan wachtrij toevoegen en wissen, een item afspelen,
willekeurig afspelen, doorkijken hervatten, als bekeken markeren, favoriet
omschakelen, aan een afspeellijst toevoegen, een bericht naar de client sturen,
bibliotheekscan starten, server herstarten of afsluiten, health check.

WIDGETS

Serveroverzicht — actieve streams, bibliotheektotalen en kaarten per stream met
voortgang en een transcoding-badge.

Nu bezig — poster met een sleepbare voortgangsbalk en een volledige knoppenrij.

INSTELLEN

1. Maak in Jellyfin een API-sleutel aan (Dashboard, API-sleutels).
2. Voeg in Homey het Jellyfin-server-apparaat toe, voer de server-URL en
   API-sleutel in, test de verbinding en kies een standaardgebruiker.
3. Voeg per persoon een Jellyfin-gebruiker-apparaat toe.
4. Voeg de widgets toe aan je dashboard.

Auteur: Fabian-René Lorenzen
