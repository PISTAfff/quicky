/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { initTheme } from "./lib/theme";
import { followWindowAnim } from "./lib/winanim";
import "./styles.css";

initTheme();
followWindowAnim(true);
render(() => <App />, document.getElementById("root") as HTMLElement);
