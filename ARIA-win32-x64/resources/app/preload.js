const { contextBridge, ipcRenderer } = require('electron');

/**
 * The contextBridge ensures that the Renderer process can communicate 
 * with the Main process securely, only exposing a set of predefined functions.
 */
contextBridge.exposeInMainWorld('electronAPI', {
    // File System Operations
    getProjectStructure: (rootPath) => ipcRenderer.invoke('get-project-structure', rootPath),
    openFolder: () => ipcRenderer.invoke('open-folder'),
    openFile: () => ipcRenderer.invoke('open-file'),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
    createFile: (filePath, content) => ipcRenderer.invoke('create-file', filePath, content),

    // Indexing
    indexProject: (rootPath) => ipcRenderer.invoke('index-project', rootPath),

    // AI Communication
    askAI: (prompt, currentFileContent, fileStructure, mode = 'chat', modelId = null, repoMap = null, conversationHistory = []) => 
        ipcRenderer.invoke('ask-ai', { prompt, currentFileContent, fileStructure, mode, modelId, repoMap, conversationHistory }),
    setAIModel: (modelId) => ipcRenderer.invoke('set-ai-model', modelId),
    cancelAI: () => ipcRenderer.invoke('cancel-ai'),

    // Settings management
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    fetchProviderModels: (baseUrl, apiKey) => ipcRenderer.invoke('fetch-provider-models', { baseUrl, apiKey }),

    // Terminal
    runTerminalCommand: (command, cwd) => ipcRenderer.invoke('run-terminal-command', command, cwd),
    killTerminalCommand: (pid) => ipcRenderer.invoke('kill-terminal-command', pid),
    startTerminalSession: (cwd) => ipcRenderer.invoke('start-terminal-session', cwd),
    sendTerminalInput: (text) => ipcRenderer.invoke('send-terminal-input', text),
    killTerminalSession: () => ipcRenderer.invoke('kill-terminal-session'),
    onTerminalData: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('terminal-data', subscription);
        return () => ipcRenderer.removeListener('terminal-data', subscription);
    },

    // App Info
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Open External Link
    openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),
    toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),
    zoomIn: () => ipcRenderer.invoke('zoom-in'),
    zoomOut: () => ipcRenderer.invoke('zoom-out'),
    zoomReset: () => ipcRenderer.invoke('zoom-reset'),

    // Git Operations
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    gitClone: (repoUrl, targetFolder) => ipcRenderer.invoke('git-clone', { repoUrl, targetFolder }),
    gitFetch: (projectRoot) => ipcRenderer.invoke('git-fetch', { projectRoot }),
    gitStatus: (projectRoot) => ipcRenderer.invoke('git-status', { projectRoot })
});
