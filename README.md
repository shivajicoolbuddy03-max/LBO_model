# LBO Model with Claude — mobile app

A multi-agent Claude pipeline (research → structuring → debt → valuation →
cash flow → risk → exit) that builds a leveraged buyout model and exports a
fully formula-driven Excel workbook. This repo wraps the original React
component in a real build (Vite) and a native app shell (Capacitor), so it
can run as an installable Android/iOS app instead of only inside the
Claude.ai Artifact preview.

## How it gets its data

Two ways to build a model, chosen from the mode selector on the home screen:

- **Standard logic / My own criteria** — six Claude agents research the
  target's public filings and propose the assumptions. This calls the
  Anthropic API directly from the device, so it needs **your own API key**
  (key icon, top right of the app → paste a key from
  [console.anthropic.com](https://console.anthropic.com)). The key is stored
  only in the app's local storage on that device; it is never sent anywhere
  but `api.anthropic.com`.
- **Manual entry** — skip the AI agents entirely. Type in the target's
  financials and every assumption yourself. No API key, no network calls.

If a key is set but the risk-analysis/exit-route agents fail or are skipped,
the model still builds with sensible defaults — those two sections are the
only thing that needs a key.

## Project layout

```
index.html, vite.config.js, src/          Vite web app (the actual UI/logic)
capacitor.config.json                     Capacitor app config (id, name, dist dir)
android/                                  Generated native Android project
ios/                                      (not generated here — see below)
```

## Running it as a normal web app

```bash
npm install
npm run dev        # dev server on http://localhost:5173
npm run build       # production build to dist/
```

## Building the Android app

This was scaffolded with `npx cap add android` and committed, but the actual
APK build needs the Android SDK + Google's Maven repo (`dl.google.com`),
which this sandbox's network policy blocks — so the final build has to
happen on your own machine or in your own CI:

```bash
npm install
npm run build
npx cap sync android
npx cap open android      # opens Android Studio
```

From Android Studio: let Gradle sync (needs internet access to
`dl.google.com` and `repo.maven.apache.org`), then Run ▸ Run 'app' on a
device/emulator, or Build ▸ Generate Signed Bundle/APK for a release build.

Whenever you change the web app (`src/`), re-run `npm run build && npx cap
sync android` before rebuilding in Android Studio — Capacitor copies the
built web assets into `android/app/src/main/assets/public`, it doesn't
watch `src/` directly.

## Building the iOS app

Not generated in this repo — Capacitor's iOS platform needs Xcode/CocoaPods,
which only run on macOS. On a Mac, from a checkout of this repo:

```bash
npm install
npm run build
npx cap add ios
npx cap sync ios
npx cap open ios          # opens Xcode
```

Then set a signing team in Xcode's Signing & Capabilities tab and run on a
simulator or device.

## App identity

`capacitor.config.json` sets the app ID to `com.lbomodel.withclaude` and the
display name to "LBO Model with Claude". Change `appId` before your first
real build if you plan to publish it — the app ID can't be changed after a
store listing is created.
