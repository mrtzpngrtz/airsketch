# AirSketch

Smart pen application for NeoLab smart pens.

## Setup

```bash
npm install
npm start
```

## What it does

- Connects to NeoLab smart pens via Bluetooth
- Captures handwritten strokes in real-time
- Renders drawings on canvas
- Sends pen coordinates via OSC to `127.0.0.1:9000` on `/pen` address
  - Format: `x (float 0-1), y (float 0-1), type (int 0=down, 1=move, 2=up)`

Built with Electron.
