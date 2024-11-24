const fs = require('fs');
const path = require('path');

// Store rate limits and connection tracking
const rateLimits = {};
const connectionTracker = {};

// Configuration
const CONFIG = {
    MAX_REQUESTS: 100,      // Maximum requests per window
    WINDOW_SIZE: 60000,     // Time window in milliseconds (60 seconds)
    LOG_FILE: 'ip_access.log'
};

function logIPAccess(ip, method, status, msg = "**") {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - IP: ${ip} - Method: ${method} :: ${msg} - Status: ${status}\n`;
    
    fs.appendFile(CONFIG.LOG_FILE, logMessage, (err) => {
        if (err) {
            console.error('Error writing to IP log:', err);
        }
    });
}

function getClientIP(socket) {
    // Try to get IP from proxy headers if behind a proxy
    const forwardedFor = socket.handshake?.headers?.['x-forwarded-for'];
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    
    // Get direct IP, handling both IPv4 and IPv6
    const remoteAddress = socket.remoteAddress;
    // If IPv6 localhost, convert to IPv4 localhost
    if (remoteAddress === '::1') {
        return '127.0.0.1';
    }
    // Handle IPv6 addresses
    if (remoteAddress.includes('::ffff:')) {
        return remoteAddress.split('::ffff:')[1];
    }
    
    return remoteAddress;
}

function rateLimiter(socket, method = 'UNKNOWN', msg) {
    const ip = getClientIP(socket);
    const now = Date.now();
    
    // Initialize tracking for this IP if it doesn't exist
    if (!rateLimits[ip]) {
        rateLimits[ip] = [];
        connectionTracker[ip] = {
            firstSeen: now,
            totalRequests: 0,
            lastRequest: now
        };
    }
    
    // Update connection tracking
    connectionTracker[ip].totalRequests++;
    connectionTracker[ip].lastRequest = now;
    
    // Clean up old requests outside the window
    rateLimits[ip] = rateLimits[ip].filter(timestamp => 
        now - timestamp < CONFIG.WINDOW_SIZE
    );
    
    // Check if limit exceeded
    if (rateLimits[ip].length >= CONFIG.MAX_REQUESTS) {
        logIPAccess(ip, method, 'RATE_LIMITED', "OverFlow");
        return false;
    }
    
    // Record this request
    rateLimits[ip].push(now);
    logIPAccess(ip, method, 'ACCEPTED', msg);
    
    return true;
}

// Cleanup function to prevent memory leaks
function cleanupTracking() {
    const now = Date.now();
    
    // Clean up IPs that haven't made requests in the last hour
    Object.keys(connectionTracker).forEach(ip => {
        if (now - connectionTracker[ip].lastRequest > 3600000) { // 1 hour
            delete rateLimits[ip];
            delete connectionTracker[ip];
        }
    });
}

// Run cleanup every hour
setInterval(cleanupTracking, 3600000);

// Function to get connection statistics
function getConnectionStats(ip) {
    if (!connectionTracker[ip]) {
        return null;
    }
    
    return {
        ip,
        firstSeen: new Date(connectionTracker[ip].firstSeen).toISOString(),
        totalRequests: connectionTracker[ip].totalRequests,
        lastRequest: new Date(connectionTracker[ip].lastRequest).toISOString(),
        currentWindowRequests: rateLimits[ip]?.length || 0
    };
}

module.exports = {
    logIPAccess,
    rateLimiter,
    getClientIP,
    getConnectionStats
};
