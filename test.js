const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getClientIP, getConnectionStats } = require('./ip-rate-limiter');

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