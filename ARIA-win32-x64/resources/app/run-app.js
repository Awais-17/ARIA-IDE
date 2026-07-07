const concurrently = require('concurrently');

// Start Vite and Electron concurrently, ignoring any extra CLI arguments passed by npm start
const { result } = concurrently([
    { command: 'npm run dev', name: 'vite', prefixColor: 'cyan' },
    { command: 'npm run electron', name: 'electron', prefixColor: 'magenta' }
], {
    prefix: 'name',
    killOthers: ['failure', 'success'],
    restartTries: 0
});

result.then(
    () => process.exit(0),
    (err) => {
        // Log error but exit gracefully
        console.error('App exited:', err);
        process.exit(1);
    }
);
