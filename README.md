# 🎤 Joke Planner

A small web app for stand-up comedians: write your jokes, time them, and drag them into sets that hit a target length.

No accounts, no server, no build step. It's plain HTML, CSS and JavaScript, and everything is saved in your browser.

## Features

- **Joke library**: title, full script and length for each joke. Search and sort by newest, title or length.
- **Length estimates**: leave the length blank and it's estimated from the script's word count (about 150 words a minute, shown with a `~`).
- **Build sets by dragging**: drag jokes from the library into a set, drag to reorder, or drag a joke back to the library to remove it. On phones, drag by the ⠿ handle. You can also use the ＋ / ✕ buttons, or the keyboard (focus a card, then Alt+↑/↓ to move it and Delete to remove it).
- **Target time**: set a target in minutes. The set shows total time, time left or over, and when each joke starts (`@2:30`).
- **Multiple sets**: create, rename, duplicate and delete sets (for example "5 min open mic" or "10 min showcase").
- **Time a joke** (⏱): perform it out loud with the script on screen. The clock starts when you start talking, and dead air at the end is trimmed off.
- **Record a new joke** (● Record joke): perform a new bit and it's timed and transcribed into the script (speech-to-text works in Chrome, Edge and Safari). It can also stop on its own after a few seconds of silence.
- **Saving and export**:
  - Auto-saves in your browser as you work.
  - **⬇ Backup** downloads everything (all jokes and sets) as a `.json` file. **⬆ Restore** loads one back, either merged with what you have or replacing it.
  - **Export** a set as a `.txt` set list, with or without scripts, copy it to the clipboard, or print it in big type for the stage.

## Running it

Microphone features need the page to be served over `https://` or from `localhost`. Pick one of these:

**Option 1: run it locally**

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

**Option 2: host it free on GitHub Pages**

The repo has a workflow (`.github/workflows/pages.yml`) that publishes the app every time the default branch changes. To switch it on (one time only):

1. In the repo on GitHub, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source** to **GitHub Actions**.
3. Go to **Actions → Deploy to GitHub Pages → Run workflow** (or push any change).
4. After a minute your app is live at `https://<your-username>.github.io/joke-planner/`.

You can also double-click `index.html` to open it directly. Writing jokes and building sets will work, but the browser may block the microphone.

## Don't lose your work

Your data lives in this browser's local storage. It survives reloads and restarts, but **not** clearing your browsing data, and it doesn't sync between devices or browsers. Press **⬇ Backup** now and then. The button gets highlighted if you haven't backed up in a week. To move to another device, back up on one and restore on the other.

## Privacy

- Jokes are stored only in your browser.
- Timing (voice detection) runs entirely on your device.
- Speech-to-text uses the browser's built-in speech service, which in Chrome sends audio to Google and in Safari to Apple. Turn off "Transcribe my words" under *Timing options* if you'd rather not, and timing will still work.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout and dialogs |
| `styles.css` | Styling (light and dark mode, mobile layout, print layout) |
| `app.js` | Jokes, sets, drag and drop, saving, import/export |
| `voice.js` | Microphone timing (voice activity detection) and speech-to-text |
