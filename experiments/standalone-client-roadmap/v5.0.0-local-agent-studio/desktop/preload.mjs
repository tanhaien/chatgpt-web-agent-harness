import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("localAgentStudio", {
  platform: process.platform,
  privileged(action, payload = {}) {
    return ipcRenderer.invoke("lca:privileged", { action, payload });
  },
  onServerExit(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("studio-server-exit", handler);
    return () => ipcRenderer.removeListener("studio-server-exit", handler);
  }
});
