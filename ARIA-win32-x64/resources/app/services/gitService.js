const { ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const path = require('path');

function registerGitHandlers(mainWindow) {
    // Select folder dialog
    ipcMain.handle('select-folder', async () => {
        if (!mainWindow) return null;
        try {
            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory']
            });
            if (canceled || filePaths.length === 0) return null;
            return filePaths[0];
        } catch (err) {
            console.error("Select folder error:", err);
            return null;
        }
    });

    // Git Clone
    ipcMain.handle('git-clone', async (event, { repoUrl, targetFolder }) => {
        return new Promise((resolve) => {
            console.log(`Cloning ${repoUrl} into ${targetFolder}`);
            exec(`git clone "${repoUrl}"`, { cwd: targetFolder }, (error, stdout, stderr) => {
                if (error) {
                    console.error("Git clone failed:", error);
                    resolve({ success: false, error: error.message, stderr });
                } else {
                    let repoName = 'project';
                    try {
                        const parts = repoUrl.split('/');
                        const lastPart = parts[parts.length - 1];
                        repoName = lastPart.replace(/\.git$/, '') || 'project';
                    } catch (e) {
                        console.error("Failed to parse repo name from url:", e);
                    }
                    const clonedPath = path.join(targetFolder, repoName);
                    resolve({ success: true, stdout, stderr, clonedPath });
                }
            });
        });
    });

    // Git Fetch
    ipcMain.handle('git-fetch', async (event, { projectRoot }) => {
        return new Promise((resolve) => {
            if (!projectRoot) {
                return resolve({ success: false, error: "No project root opened" });
            }
            console.log(`Fetching in ${projectRoot}`);
            exec('git fetch', { cwd: projectRoot }, (error, stdout, stderr) => {
                if (error) {
                    console.error("Git fetch failed:", error);
                    resolve({ success: false, error: error.message, stderr });
                } else {
                    resolve({ success: true, stdout, stderr });
                }
            });
        });
    });

    // Git Status
    ipcMain.handle('git-status', async (event, { projectRoot }) => {
        return new Promise((resolve) => {
            if (!projectRoot) {
                return resolve({ isRepo: false });
            }
            exec('git rev-parse --is-inside-work-tree', { cwd: projectRoot }, (err, stdout) => {
                if (err || stdout.trim() !== 'true') {
                    return resolve({ isRepo: false });
                }
                
                exec('git branch --show-current', { cwd: projectRoot }, (err2, stdout2) => {
                    const branch = err2 ? 'unknown' : stdout2.trim() || 'HEAD (detached)';
                    
                    exec('git status --porcelain', { cwd: projectRoot }, (err3, stdout3) => {
                        const changes = err3 ? [] : stdout3.split('\n').filter(Boolean).map(line => {
                            const status = line.slice(0, 2);
                            const file = line.slice(3);
                            return { status, file };
                        });
                        resolve({ isRepo: true, branch, changes });
                    });
                });
            });
        });
    });
}

module.exports = { registerGitHandlers };
