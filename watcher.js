const { exec } = require('child_process');

// Function to start the server
function startServer() {
    const server = exec('node server_v2.js');  // Adjust the filename accordingly

    // Log output from the server
    server.stdout.on('data', (data) => {
        console.log(data);
    });

    server.stderr.on('data', (data) => {
        console.error(data);
    });

    // Restart the server if it crashes
    server.on('exit', (code) => {
        console.log(`Server stopped with exit code ${code}. Restarting...`);
        startServer();  // Restart the server
    });
}

// Start the server for the first time
startServer();
