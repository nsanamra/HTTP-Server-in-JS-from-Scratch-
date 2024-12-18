const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rateLimiter, getClientIP, logIPAccess, getConnectionStats } = require('./ip-rate-limiter');

const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let isHttpRequest = false;
    let expectedLength = -1;
    let headersParsed = false;

    socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
        const dataStr = data.toString();
        
        // Handle COMM command
        if (dataStr.trim().startsWith('COMM')) {
            const message = dataStr.trim().substring(4).trim();
            handleCommMethod(socket, message);
            buffer = Buffer.alloc(0);
            return;
        }

        // Handle GET_INFO
        if(dataStr.trim().startsWith('GET_INFO')){
            const stats = getConnectionStats(getClientIP(socket).toString());
            
            const response = `
                IP Address: ${stats.ip}
                First Seen: ${stats.firstSeen}
                Total Requests: ${stats.totalRequests}
                Last Request: ${stats.lastRequest}
                Current Window Requests: ${stats.currentWindowRequests}
            `;

            socket.write(response, (err) => {
                if(err){
                    console.error("Write error : ", err);
                }
            });
            buffer = Buffer.alloc(0);
            return;
        }

        // Handle GET_LIST
        if(dataStr.trim().startsWith('GET_LIST')){
            handleFileList(socket);
            buffer = Buffer.alloc(0);
            return;
        }
        
        // Handle HTTP requests
        if (dataStr.startsWith('POST')) {
            isHttpRequest = true;
            
            // Only parse headers once
            if (!headersParsed) {
                const headerEndIndex = buffer.indexOf('\r\n\r\n');
                if (headerEndIndex !== -1) {
                    const headers = buffer.slice(0, headerEndIndex).toString();
                    const contentLengthMatch = headers.match(/Content-Length: (\d+)/i);
                    if (contentLengthMatch) {
                        expectedLength = parseInt(contentLengthMatch[1]);
                        headersParsed = true;
                    }
                }
            }

            // Check if we have received the complete request
            if (headersParsed) {
                const headerEndIndex = buffer.indexOf('\r\n\r\n');
                const bodyLength = buffer.length - (headerEndIndex + 4);
                
                if (bodyLength >= expectedLength) {
                    handleRequest(socket, buffer);
                    buffer = Buffer.alloc(0);
                    headersParsed = false;
                    expectedLength = -1;
                }
            }
        } else if (dataStr.startsWith('GET')) {
            isHttpRequest = true;
            handleRequest(socket, data);
            buffer = Buffer.alloc(0);
        } else if (dataStr.trim().startsWith('DELETE')){
            isHttpRequest = true;
            const requestLine = dataStr.toString().split('\r\n')[0];
            const path = requestLine.split(' ')[1]; 
            handleDeleteMethod(socket, path);
            buffer = Buffer.alloc(0);
        }
    });

    socket.on("end", () => {
        if (isHttpRequest && buffer.length > 0) {
            handleRequest(socket, buffer);
        }
    });

    socket.setTimeout(120000); // 2 minutes timeout
    socket.on('timeout', () => {
        sendResponse(socket, 408, "Request timeout");
        socket.end();
    });
});

function validatePath(filePath) {
    const homeDir = os.homedir();
    const normalizedPath = path.normalize(filePath);
    
    if (!normalizedPath.startsWith(homeDir)) {
        throw new Error('Access denied: Path outside home directory');
    }
    return normalizedPath;
}

function handleRequest(socket, data) {
    try {
        const request = data.toString('utf8', 0, data.indexOf('\r\n')).trim();
        const [method, ...rest] = request.split(' ');
        let reqPath;

        if (!rateLimiter(socket, method, rest[0])) {
            sendResponse(socket, 429, "Too Many Requests");
            socket.end();
            return;
        }

        switch (method) {
            case 'GET':
                reqPath = rest[0];
                if (!reqPath) {
                    sendResponse(socket, 400, "Path is required");
                    return;
                }
                handleGetMethod(socket, reqPath);
                break;
            case 'POST':
                reqPath = rest[0];
                if (!reqPath) {
                    sendResponse(socket, 400, "Path is required");
                    return;
                }
                handlePostMethod(socket, reqPath, data);
                break;
            case 'DELETE':
                reqPath = rest[0];
                if (!reqPath) {
                    sendResponse(socket, 400, "Path is required");
                    return;
                }
                handleDeleteMethod(socket, reqPath);
                break;
            default:
                sendResponse(socket, 405, "Method not allowed");
        }
    } catch (error) {
        console.error('Request handling error:', error);
        sendResponse(socket, 500, "Internal server error");
    }
}

function handleCommMethod(socket, message) {
    try {
        if (!message || message.trim().length === 0) {
            socket.write("400 Message cannot be empty\r\n");
            return;
        }
        console.log('Received message:', message);
        logIPAccess(getClientIP(socket), 'COMM', 200, message);
        socket.write(`200 Server received: ${message}\r\n`);
    } catch (error) {
        console.error('COMM handling error:', error);
        socket.write("500 Error processing message\r\n");
    }
}

function handleFileList(socket) {
    try {
        const homeDir = os.homedir();
        const desktopPath = path.join(homeDir, 'Desktop');
        const serverDirPath = path.join(desktopPath, 'server');

        // Ensure that the 'server' directory exists before proceeding
        if (!fs.existsSync(serverDirPath)) {
            sendResponse(socket, 404, "Server directory not found");
            return;
        }

        // Read the directory contents
        fs.readdir(serverDirPath, (err, files) => {
            if (err) {
                console.error('Error reading directory:', err);
                sendResponse(socket, 500, "Error reading directory");
                return;
            }

            // If the directory is empty, send a message to the client
            if (files.length === 0) {
                sendResponse(socket, 404, "No files found in the server folder");
            } else {
                // Create a list of file details
                const fileDetails = files.map(file => {
                    const filePath = path.join(serverDirPath, file);
                    const stats = fs.statSync(filePath);  // Get file statistics

                    // Prepare file info string
                    const fileInfo = `${file} - Size: ${stats.size} bytes - Last Modified: ${stats.mtime}`;
                    return fileInfo;
                }).join('\n');  // Join file info with a newline

                logIPAccess(getClientIP(socket), "GET_LIST", 200, "Done");
                // Send the file list with details
                sendResponse(socket, 200, `Files in 'server' folder:\n${fileDetails}`);
            }
        });
    } catch (error) {
        console.error('Error handling file list request:', error);
        sendResponse(socket, 500, "Internal server error");
    }
}

function handleGetMethod(socket, reqPath) {
    try {
        const homeDir = os.homedir();
        const sourceFilePath = path.join('.', reqPath);
        const targetFilePath = validatePath(path.join(homeDir, reqPath));

        if (!fs.existsSync(sourceFilePath)) {
            sendResponse(socket, 404, "Source file not found");
            return;
        }

        const targetDir = path.dirname(targetFilePath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.readFile(sourceFilePath, (err, data) => {
            if (err) {
                console.error('File read error:', err);
                if (socket.writable) {
                    sendResponse(socket, 500, "Error reading file");
                }
                return;
            }

            //Send the file as a response
            const responseHeaders = `HTTP/1.1 200 OK\r\n` +
                `Content-Type: application/octet-stream\r\n` +
                `Content-Disposition: attachment; filename="${path.basename(reqPath)}"\r\n` +
                `Content-Length: ${data.length}\r\n` +
                `Connection: close\r\n\r\n`;

            // Write headers and file data to the socket
            socket.write(responseHeaders);
            socket.write(data);
            sendResponse(socket, 200, `File successfully saved to ${targetFilePath}`);
        });
    } catch (error) {
        console.error('GET handling error:', error);
        if (socket.writable) {
            sendResponse(socket, 500, error.message);
        }
    }
}

function handlePostMethod(socket, reqPath, data) {
    try {
        const homeDir = os.homedir();
        const targetFilePath = validatePath(path.join(homeDir, reqPath));
        
        const targetDir = path.dirname(targetFilePath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Find the boundary between headers and body
        const headerEndIndex = data.indexOf('\r\n\r\n');
        if (headerEndIndex === -1) {
            sendResponse(socket, 400, "Invalid request format");
            return;
        }

        // Extract the body after headers
        const body = data.slice(headerEndIndex + 4);
        
        // Write the file
        fs.writeFile(targetFilePath, body, (err) => {
            if (err) {
                console.error('Save error:', err);
                sendResponse(socket, 500, "Error saving file");
                return;
            }
            sendResponse(socket, 200, `File successfully saved to ${targetFilePath}`);
            console.log(`File saved to: ${targetFilePath}`);
        });
        
    } catch (error) {
        console.error('POST handling error:', error);
        sendResponse(socket, 500, error.message);
    }
}

function handleDeleteMethod(socket, reqPath) {
    try {
        if (!reqPath || typeof reqPath !== 'string') {
            sendResponse(socket, 400, "Invalid request format");
            return;
        }

        // Clean up the request path
        const cleanPath = reqPath.replace(/^\//, '').trim(); // Remove leading slash and whitespace
        if (!cleanPath) {
            sendResponse(socket, 400, "Invalid file path");
            return;
        }

        // Build the full file path within the server directory
        const homeDir = os.homedir();
        const serverDir = path.join(homeDir, 'Desktop', 'server');
        const filePath = path.join(serverDir, cleanPath);

        // Validate the path is within the server directory
        const normalizedPath = path.normalize(filePath);
        if (!normalizedPath.startsWith(serverDir)) {
            sendResponse(socket, 403, "Access denied: Invalid path");
            return;
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            sendResponse(socket, 404, `File ${cleanPath} not found`);
            return;
        }

        // Check if it's actually a file (not a directory)
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            sendResponse(socket, 400, "Cannot delete: Not a file");
            return;
        }

        // Delete the file
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Delete error:', err);
                sendResponse(socket, 500, "Error deleting file");
                return;
            }
            
            logIPAccess(getClientIP(socket), 'DELETE', 'ACCEPTED', filePath);
            sendResponse(socket, 200, `File ${cleanPath} deleted successfully`);
        });

    } catch (error) {
        console.error('DELETE handling error:', error);
        sendResponse(socket, 500, "Internal server error");
    }
}

function sendResponse(socket, statusCode, message, contentType = 'text/plain') {
    try {
        if (!socket.writable) {
            console.log('Socket is no longer writable');
            return;
        }

        const response = `HTTP/1.1 ${statusCode} ${getStatusText(statusCode)}\r\n` +
            `Content-Type: ${contentType}\r\n` +
            `Content-Length: ${Buffer.byteLength(message)}\r\n` +
            'Connection: close\r\n' +
            '\r\n' +
            message;

        socket.write(response, (err) => {
            if (err) {
                console.error('Write error:', err);
            }
        });
    } catch (error) {
        console.error('Response error:', error);
        if (!socket.destroyed) {
            socket.destroy();
        }
    }
}

function getStatusText(code) {
    const statusTexts = {
        200: 'OK',
        400: 'Bad Request',
        404: 'Not Found',
        405: 'Method Not Allowed',
        408: 'Request Timeout',
        500: 'Internal Server Error'
    };
    return statusTexts[code] || 'Unknown';
}

server.listen(9999, () => {
    console.log("Server listening on port 9999");
});

server.on('error', (error) => {
    console.error('Server error:', error);
    process.exit(1);
});

server.on('connection', (socket) => {
    const clientIP = getClientIP(socket);
    console.log(`New client connected from IP: ${clientIP}`);
    
    socket.on('error', (error) => {
        if (error.code === 'ECONNRESET') {
            console.log(`Client ${clientIP} disconnected abruptly`);
        } else {
            console.error(`Socket error for ${clientIP}:`, error);
        }
    });

    socket.on('end', () => {
        console.log(`Client ${clientIP} disconnected`);
    });
});

