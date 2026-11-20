# ChatPulse 💬📞📹

A modern, real-time web chatting and calling application built with **Python (Flask)**, **WebSockets (Socket.IO)**, **WebRTC**, **HTML5**, **CSS3**, and **Vanilla JavaScript**, featuring **Email OTP Authentication**.

---

## 🚀 Features

* **Authentication**: Passwordless Email OTP login with built-in instant dev/demo mode & optional real SMTP delivery.
* **Realtime Chats**: Text messaging, photo sharing, voice memo audio recording with waveform playback, emoji reactions, read receipts, and live typing indicators.
* **Voice Calls**: WebRTC peer-to-peer real-time audio calling, mute/unmute, speaker toggle, running call duration timer, and animated audio wave visualizer.
* **Video Calls**: WebRTC peer-to-peer HD video calling, local Picture-in-Picture (PiP) preview, flip camera, camera on/off toggle, and remote view.
* **Call History**: Dedicated Calls tab with All vs. Missed call filters, duration, timestamps, and one-click redial.
* **Profile with All Features**: 12 avatar presets, editable display name, bio/status chips, presence status (Online, Busy, Away, Invisible), personal QR code sharing, Light/Dark theme toggle, accent color selector, and cache cleaner.

---

## 🛠️ Project Structure

```text
chatapp/
├── app.py                  # Flask server, REST APIs, SQLite database & Socket.IO signaling
├── requirements.txt        # Python dependencies
├── static/
│   ├── css/
│   │   └── style.css       # Clean, responsive styling & Dark/Light themes
│   ├── js/
│   │   ├── app.js          # Client-side state, UI handlers & Socket.IO client
│   │   └── webrtc.js       # WebRTC peer-to-peer audio & video call manager
│   └── uploads/            # Uploaded photos and audio notes
├── templates/
│   └── index.html          # Single Page Application HTML5 markup
├── chatapp.db              # SQLite persistent database (auto-generated)
└── README.md
```

---

## 🏁 Getting Started

### 1. Install Requirements
```bash
pip install -r requirements.txt
```

### 2. Run the App
```bash
python app.py
```

### 3. Open in Browser
Visit **[http://localhost:5000](http://localhost:5000)** in your browser!
