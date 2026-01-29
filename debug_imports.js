const path = require('path');

try {
    console.log("Attempting to import PenHelper...");
    const PenHelper = require('web_pen_sdk/dist/PenCotroller/PenHelper').default;
    console.log("PenHelper imported successfully.");
} catch (e) {
    console.error("Failed to import PenHelper:", e);
}

try {
    console.log("Attempting to import PenMessageType...");
    const PenMessageType = require('web_pen_sdk/dist/API/PenMessageType').default;
    console.log("PenMessageType imported successfully.");
} catch (e) {
    console.error("Failed to import PenMessageType:", e);
}

try {
    console.log("Attempting to import PenController...");
    // Adjust path based on where we think it is
    const PenController = require('web_pen_sdk/dist/PenCotroller/PenController').default;
    console.log("PenController imported successfully.");
} catch (e) {
    console.error("Failed to import PenController:", e);
}
