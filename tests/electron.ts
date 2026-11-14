/** Electron's main-process module only exists inside Electron: every test gets mist's fakeElectron (bunfig.toml preload). */
import { mock } from "bun:test";

import { fakeElectron } from "../src/testing";

export const electron = fakeElectron();

mock.module("electron", () => electron.module);
