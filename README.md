# ToDoApp – Phase 1

Persönliche Aufgaben-App (angelehnt an TickTick) mit **Listen**, **Bereichen**, **Kategorien** und einer
**3×3-Matrix aus Dringlichkeit × Wichtigkeit**. PWA auf Cloudflare Pages, Daten in Cloudflare D1,
geschützt durch Cloudflare Access.

## Funktionsumfang Phase 1
- Aufgaben mit Titel, Notizen, Fälligkeit (Datum + Uhrzeit), Unteraufgaben (eine Ebene)
- Jede Aufgabe: **Dringlichkeit** und **Wichtigkeit** (Niedrig / Mittel / Hoch), initial *Niedrig*
- Neue Aufgaben gelten als **„unbewertet“**, bis du sie einordnest (eigene Ansicht + Hinweisleiste)
- **Bereich** und **Kategorie** (je eine pro Aufgabe), initial *Allgemein*; frei anlegbar, umbenennbar, löschbar
  (Aufgaben wandern beim Löschen zurück nach *Allgemein*)
- **Listen** wie in TickTick, Standardliste *Eingang*
- Ansichten: Alle, Heute (inkl. überfällig), Nächste 7 Tage, Unbewertet, Erledigt (90 Tage)
- **Liste** (gruppiert nach Fälligkeit, sortiert nach Priorität) und **Matrix** (3×3, „＋“ in jeder Zelle)
- Filter nach Bereich und Kategorie, Volltextsuche
- Schnelleingabe versteht `heute`, `morgen`, `übermorgen` am Ende („Arzt anrufen morgen“)
- Sync zwischen Geräten über D1; lokale Kopie für schnellen Start und Lesen offline

## Phase 2 (Kalender, Erinnerungen, Wiederholungen)
- Ansicht **Kalender**: Monatsraster mit Punkten (Farbe = Priorität), Tagesliste, geplante Wiederholungen
- **Wiederholungen**: täglich, werktags, wöchentlich, monatlich, jährlich, benutzerdefiniert (alle X, Wochentage, Enddatum).
  Beim Abhaken springt die Aufgabe auf den nächsten Termin, eine erledigte Kopie bleibt als Historie.
- **Erinnerungen** per Web Push (Aufgaben mit Uhrzeit): zur Fälligkeit, 5/15/60 Min. oder 1 Tag vorher
- **Morgen-Übersicht** (Standard 07:30, im Menü änderbar)
- Push aktivieren: Menü ☰ → Benachrichtigungen. iPhone: nur in der installierten App (Home-Bildschirm).

Technik: Der Worker `todoapp-reminder` (Ordner `reminder-worker/`, nutzt `lib/webpush.js`) läuft alle 5 Minuten per Cron
und greift auf dieselbe D1-Datenbank zu. Er wird per Cloudflare-API deployt (nicht automatisch über GitHub).
VAPID-Schlüssel liegen als Variable/Secret im Pages-Projekt und im Worker (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK`, `VAPID_SUBJECT`).

**Noch nicht in Phase 1:** Wiederholungen, Erinnerungen/Push, Kalender (Phase 2) – Habits, Pomodoro, KI (Phase 3).
Offline kannst du lesen, Änderungen ohne Netz werden aber **nicht** gespeichert (Hinweis erscheint).

## Dateien
```
functions/api/[[path]].js   API (Pages Function): Auth-Prüfung, D1, legt Tabellen selbst an
public/index.html           Oberfläche + CSS
public/app.js               App-Logik (ES5, kein Build)
public/sw.js                Service Worker (App-Hülle offline, /api nie gecacht)
public/manifest.webmanifest PWA-Manifest
public/icon.svg, icon-192.png, icon-512.png
```

## Einrichtung (nur Browser)

### 1. GitHub
1. Neues Repository **ToDoApp** anlegen (privat empfohlen).
2. *Add file → Upload files* und den **Inhalt** des Ordners `ToDoApp` hineinziehen
   (die Ordner `functions` und `public` müssen erhalten bleiben). Commit.

### 2. D1-Datenbank
Cloudflare-Dashboard → *Storage & Databases → D1* → *Create* → Name `todoapp-db`,
Standort Westeuropa. **Kein SQL nötig** – die Tabellen legt die App beim ersten Aufruf selbst an.

### 3. Pages-Projekt
*Workers & Pages → Create → Pages → Connect to Git* → Repo `ToDoApp`:
- Framework preset: **None**
- Build command: **leer** lassen (falls Pflichtfeld: `exit 0`)
- Build output directory: **`public`**

Nach dem ersten Deploy: *Settings → Bindings → Add → D1 database* → Variablenname **`DB`** → `todoapp-db`.

### 4. Cloudflare Access (Login)
*Zero Trust → Access → Applications → Add an application → Self-hosted*:
- Application domain: deine Pages-Adresse, z. B. `todoapp.pages.dev`
  (zusätzlich `*.todoapp.pages.dev`, damit auch Vorschau-Deployments geschützt sind)
- Policy: *Allow* → Include → *Emails* → deine E-Mail-Adresse
- Nach dem Speichern: **Application Audience (AUD) Tag** kopieren
- Team-Domain findest du unter *Zero Trust → Settings* (z. B. `ralf.cloudflareaccess.com`)

### 5. Variablen im Pages-Projekt
*Settings → Variables and Secrets* (Production):

| Name | Wert |
|---|---|
| `ACCESS_TEAM_DOMAIN` | z. B. `ralf.cloudflareaccess.com` |
| `ACCESS_AUD` | AUD-Tag aus Schritt 4 |
| `ALLOWED_EMAILS` | deine E-Mail (optional, zweite Sicherung) |

Danach *Deployments → Retry deployment*, damit Binding und Variablen aktiv werden.

### 6. Aufs Handy
Seite öffnen, per E-Mail-Code anmelden, dann *Teilen → Zum Home-Bildschirm* (iPhone) bzw.
*App installieren* (Android).

## Sicherheit
Die API prüft das Access-Token selbst (Signatur, Ablauf, AUD, Aussteller). Ohne korrekt eingerichtetes
Access liefert sie absichtlich Fehler 503/401 – sie ist also nie „aus Versehen offen“.

## Fehlersuche
- **„ACCESS_TEAM_DOMAIN und ACCESS_AUD sind nicht konfiguriert“** → Schritt 5 + neu deployen
- **„D1-Binding DB fehlt“** → Schritt 3 (Binding) + neu deployen
- **„Token gehört nicht zu dieser App“** → AUD-Tag falsch kopiert
- **Endlos-Anmeldung / „Anmeldung abgelaufen“** → Seite neu laden, Access-Sitzung erneuern
