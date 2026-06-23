import * as httpClient from "./httpApiClient.js";
import * as tauriClient from "./tauriApiClient.js";

export function isTauriRuntime() {
  return Boolean(globalThis.window?.__TAURI_INTERNALS__ || globalThis.window?.__TAURI__);
}

export function selectClient() {
  return isTauriRuntime() ? tauriClient : httpClient;
}

export function fetchExports(...args) {
  return selectClient().fetchExports(...args);
}

export function fetchSettings(...args) {
  return selectClient().fetchSettings(...args);
}

export function pickSourceFolder(...args) {
  return selectClient().pickSourceFolder(...args);
}

export function updateSettings(...args) {
  return selectClient().updateSettings(...args);
}

export function fetchStats(...args) {
  return selectClient().fetchStats(...args);
}

export function fetchConversations(...args) {
  return selectClient().fetchConversations(...args);
}

export function fetchConversation(...args) {
  return selectClient().fetchConversation(...args);
}

export function fetchLibrary(...args) {
  return selectClient().fetchLibrary(...args);
}

export function assetUrl(...args) {
  return selectClient().assetUrl(...args);
}
