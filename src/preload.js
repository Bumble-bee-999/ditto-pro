'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['export:progress', 'nest:progress', 'proxy:progress', 'stabilize:progress', 'track:progress', 'bg:progress', 'app:request-close', 'app:open-path', 'collect:progress'];

contextBridge.exposeInMainWorld('ditto', {
  info: () => ipcRenderer.invoke('app:info'),
  feedback: () => ipcRenderer.invoke('app:feedback'),
  takeStartupFile: () => ipcRenderer.invoke('app:take-startup-file'),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  importDialog: () => ipcRenderer.invoke('dlg:import'),
  probe: (paths) => ipcRenderer.invoke('media:probe', paths),
  importSequence: (a) => ipcRenderer.invoke('media:importSequence', a),
  pathFor: (file) => webUtils.getPathForFile(file),
  exists: (paths) => ipcRenderer.invoke('media:exists', paths),
  waveform: (p) => ipcRenderer.invoke('media:waveform', p),
  makeProxy: (args) => ipcRenderer.invoke('media:proxy', args),
  relink: (p) => ipcRenderer.invoke('media:relink', p),
  saveProject: (args) => ipcRenderer.invoke('project:save', args),
  openProject: () => ipcRenderer.invoke('project:open'),
  readProject: (p) => ipcRenderer.invoke('project:read', p),
  autosaveWrite: (json) => ipcRenderer.invoke('autosave:write', json),
  autosaveRead: () => ipcRenderer.invoke('autosave:read'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  chooseExport: (args) => ipcRenderer.invoke('export:choose', args),
  captionsEngine: () => ipcRenderer.invoke('captions:engine'),
  generateCaptions: (a) => ipcRenderer.invoke('captions:generate', a),
  freezeFrame: (a) => ipcRenderer.invoke('media:freezeFrame', a),
  collectProject: (a) => ipcRenderer.invoke('project:collect', a),
  findBeside: (a) => ipcRenderer.invoke('media:findBeside', a),
  exportEdl: (a) => ipcRenderer.invoke('project:exportEdl', a),
  openSrt: () => ipcRenderer.invoke('captions:openSrt'),
  saveSrt: (a) => ipcRenderer.invoke('captions:saveSrt', a),
  renderNest: (a) => ipcRenderer.invoke('nest:render', a),
  nestProxy: (a) => ipcRenderer.invoke('nest:proxy', a),
  syncMulticam: (a) => ipcRenderer.invoke('multicam:sync', a),
  importProject: (a) => ipcRenderer.invoke('project:import', a),
  analyzeSilence: (a) => ipcRenderer.invoke('analyze:silence', a),
  analyzePeak: (a) => ipcRenderer.invoke('analyze:peak', a),
  saveVoice: (a) => ipcRenderer.invoke('voice:save', a),
  analyzeScenes: (a) => ipcRenderer.invoke('analyze:scenes', a),
  stabilize: (a) => ipcRenderer.invoke('stabilize:run', a),
  cancelStabilize: () => ipcRenderer.invoke('stabilize:cancel'),
  releaseProject: () => ipcRenderer.invoke('project:release'),
  whoami: () => ipcRenderer.invoke('collab:whoami'),
  exportReview: (a) => ipcRenderer.invoke('review:export', a),
  importReview: () => ipcRenderer.invoke('review:import'),
  exportCommentsCsv: (a) => ipcRenderer.invoke('review:csv', a),
  exportEncoders: () => ipcRenderer.invoke('export:encoders'),
  bgModels: () => ipcRenderer.invoke('bg:models'),
  removeBackground: (a) => ipcRenderer.invoke('bg:run', a),
  cancelBackground: () => ipcRenderer.invoke('bg:cancel'),
  trackPoint: (a) => ipcRenderer.invoke('track:point', a),
  analyzeSubject: (a) => ipcRenderer.invoke('track:subject', a),
  cancelTrack: () => ipcRenderer.invoke('track:cancel'),
  chooseLut: () => ipcRenderer.invoke('lut:choose'),
  lutData: (p) => ipcRenderer.invoke('lut:data', p),
  startExport: (args) => ipcRenderer.invoke('export:start', args),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const fn = (e, ...a) => cb(...a);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  }
});
