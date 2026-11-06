/* @refresh reload */
// The Android app's page (`mobile.html`, set as its window in `tauri.android.conf.json`).
import { render } from "solid-js/web";
import App from "./mobile/App";
import { initTheme } from "./lib/theme";
import "./styles.css";
import "./mobile/mobile.css";

initTheme();
render(() => <App />, document.getElementById("root") as HTMLElement);
