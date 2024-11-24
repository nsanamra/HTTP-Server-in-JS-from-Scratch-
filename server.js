const net = require('net');
const fs = require('fs');
const os = require('os');

// Creating a server
const server = net.createServer((socket) => {
    let fullData = Buffer.alloc(0);  // Buffer to collect all incoming data

    socket.on("data", (data) => {
        fullData = Buffer.concat([fullData, data]);  // Collect all chunks of data
    });

    socket.on("end", () => {
        // Process the full data once it's completely received
        handleRequest(socket, fullData);
    });
});

function handleRequest(socket, data) {
    // Parse the request header
    const request = data.toString('utf-8');
    const [method, ...rest] = request.split('\r\n')[0].split(' ');
    let msg, reqPath;

    // Determine method and path
    if (method === 'COMM') {
        msg = rest.join(' ');
        handleCommMethod(socket, msg);
        logRequest(method, msg, 200);
    } else if (method === 'GET') {
        reqPath = rest[0];
        handleGetMethod(socket, reqPath);
        logRequest(method, reqPath, 200);
    } else if (method === 'POST') {
        reqPath = rest[0];
        handlePostMethod(socket, reqPath, data);
        logRequest(method, reqPath, 200);
    } else {
        sendResponse(socket, 405, "Method not listed");
    }
}

// telnet localhost 9999
// COMM Message
function handleCommMethod(socket, message) {
    console.log(message);
    sendResponse(socket, 200, message, typeof(message));
}

// telnet localhost 9999
// GET /path/to/file.extension
// GET Method: Read and Save file to the home directory
function handleGetMethod(socket, reqPath) {
    const filePath = `.${reqPath}`; // Path to the requested file
    const homeDir = os.homedir();   // Get the home directory
    const saveFilePath = `${homeDir}${reqPath}`; // Path to save the file in the home directory

    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendResponse(socket, 404, "File not found");
        } else {
            // Save the file to the home directory
            fs.writeFile(saveFilePath, data, (err) => {
                if (err) {
                    sendResponse(socket, 500, "Error saving file");
                } else {
                    sendResponse(socket, 200, "File read and saved to home directory", 'text/html');
                }
            });
        }
    });
}

// curl --data-binary @/path/to/file.extension localhost:9999/saved_file.extension
// POST Method: Save binary file to home directory
function handlePostMethod(socket, reqPath, data) {
    const homeDir = os.homedir(); // Get the home directory
    const saveFilePath = `${homeDir}${reqPath}`; // Path to save the file in the home directory

    // Extract the body content after the headers (headers end with double CRLF)
    const headerEndIndex = data.indexOf("\r\n\r\n");
    const body = data.slice(headerEndIndex + 4);  // Binary body of the file

    // Save the file using binary-safe method
    saveBinaryFile(saveFilePath, body, (err) => {
        if (err) {
            sendResponse(socket, 500, "Error saving file");
        } else {
            sendResponse(socket, 200, "Binary file saved to home directory", 'text/plain');
        }
    });
}

// Function to save binary files
function saveBinaryFile(saveFilePath, data, callback) {
    // Write the binary data to the file
    fs.writeFile(saveFilePath, data, { encoding: 'binary' }, (err) => {
        if (err) {
            console.error('Error saving binary file:', err);
            return callback(err);
        }
        console.log('Binary file saved successfully');
        callback(null);  // Indicate success
    });
}

// Function to send responses
function sendResponse(socket, statusCode, message, contentType = 'text/plain') {
    const response = `HTTP/1.1 ${statusCode} ${statusCode === 200 ? 'OK' : 'Error'}\r\n` +
        `Content-Type: ${contentType}\r\n` +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        `\r\n${message}`;
    socket.write(response);
    socket.end();
}

// Log requests
function logRequest(method, info, statusCode) {
    const logMessage = `${new Date().toISOString()} - ${method} ${info} ${statusCode}\n`;

    fs.appendFileSync('server.log', logMessage, (err) => {
        if (err) throw err;
    });
}

// Start the server on port 9999
server.listen(9999, () => {
    console.log("Server listening on port 9999");
});

