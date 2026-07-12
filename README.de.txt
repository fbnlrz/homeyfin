Mediensteuerung für Jellyfin — Inoffizielle Jellyfin-Integration für Homey

Nicht mit der Jellyfin Foundation verbunden oder von ihr unterstützt. Jellyfin
ist eine Marke der Jellyfin Foundation; dies ist ein inoffizieller Client eines
Drittanbieters.

WAS DIE APP MACHT

Steuere deinen Jellyfin-Medienserver und seine Benutzer mit Homey. Jedes
Homey-Gerät steht für einen Jellyfin-Benutzer, und Wiedergabebefehle folgen dem
Benutzer automatisch zu dem Client, auf dem er gerade schaut — abends der
Wohnzimmer-TV, unterwegs das Smartphone.

GERÄTE

Jellyfin-Server — Bibliothekszähler (Filme, Serien, Folgen), zuletzt
hinzugefügter Titel, aktive Streams und Transcodes, Verbindungsstatus, Laufzeit
und Scan-Status.

Jellyfin-Benutzer — Now-Playing-Titel und Details, Position und Dauer,
Lautstärke, Cover, Anzahl ungesehener Folgen, Weiterschauen-Titel, wöchentliche
Wiedergabeminuten, Online- und Transcoding-Status.

FLOWS

Trigger: Wiedergabe gestartet, pausiert, fortgesetzt, gestoppt und gewechselt;
Fortschritts-Meilensteine und Minuten vor dem Ende; neuer Bibliotheksinhalt (mit
Poster); Bibliotheks-Scan beendet; Benutzer angemeldet; Transcoding gestartet
oder gestoppt; aktive Streams geändert; Server verbunden oder getrennt;
Tageszusammenfassung.

Bedingungen: spielt gerade, Medientyp ist, transcodiert, aktive Streams über N.

Aktionen: Play und Pause, Spulen, Kapitel überspringen, Audio- und Untertitel-
spur setzen, zur Warteschlange hinzufügen und leeren, Inhalt abspielen, zufällig
abspielen, Weiterschauen fortsetzen, als gesehen markieren, Favorit umschalten,
zu einer Playlist hinzufügen, Nachricht an den Client senden, Bibliotheks-Scan
starten, Server neu starten oder herunterfahren, Health-Check.

WIDGETS

Server-Übersicht — laufende Streams, Bibliotheks-Summen und Karten je Stream mit
Fortschritt und Transcoding-Kennzeichnung.

Läuft gerade — Poster mit ziehbarer Fortschrittsleiste und voller Steuerleiste.

EINRICHTUNG

1. Erstelle in Jellyfin einen API-Schlüssel (Dashboard, API-Schlüssel).
2. Füge in Homey das Jellyfin-Server-Gerät hinzu, gib Server-URL und
   API-Schlüssel ein, teste die Verbindung und wähle einen Standard-Benutzer.
3. Füge pro Person ein Jellyfin-Benutzer-Gerät hinzu.
4. Füge die Widgets zu deinem Dashboard hinzu.

Autor: Fabian-René Lorenzen
