/**
 * ChatPulse • WebRTC Calling Service (Audio & Video Calling)
 */

class WebRTCService {
    constructor() {
        this.pc = null;
        this.localStream = null;
        this.remoteStream = null;
        this.currentCall = null;
        this.callTimer = null;
        this.callSeconds = 0;
        this.isMuted = false;
        this.isVideoOff = false;
        this.ringtoneAudio = null;

        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        };
    }

    // Play synthetic ringtone using Web Audio API
    playRingtone() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(480, ctx.currentTime + 0.4);

            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();

            this.ringtoneAudio = { ctx, osc, gain };
        } catch (e) {
            console.log('AudioContext not allowed without user gesture yet');
        }
    }

    stopRingtone() {
        if (this.ringtoneAudio && this.ringtoneAudio.osc) {
            try {
                this.ringtoneAudio.osc.stop();
                this.ringtoneAudio.ctx.close();
            } catch (_) {}
            this.ringtoneAudio = null;
        }
    }

    // Initialize Local Media Stream
    async getMedia(callType) {
        const constraints = {
            audio: true,
            video: callType === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
        };

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            const localVid = document.getElementById('local-video');
            if (localVid && callType === 'video') {
                localVid.srcObject = this.localStream;
            }
            return this.localStream;
        } catch (err) {
            console.error('Error accessing camera/microphone:', err);
            showToast('Camera/Microphone access error: ' + err.message);
            throw err;
        }
    }

    // Start Outgoing Call
    async initiateCall(receiver, callType) {
        if (!currentUser) return;
        this.currentCall = {
            targetId: receiver.id,
            targetName: receiver.name,
            targetAvatar: receiver.avatar,
            callType: callType,
            isCaller: true,
            status: 'calling'
        };

        try {
            await this.getMedia(callType);
            this.createPeerConnection();

            this.localStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.localStream);
            });

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // Send call offer via Socket.IO
            socket.emit('call_user', {
                caller_id: currentUser.id,
                receiver_id: receiver.id,
                call_type: callType,
                offer: offer
            });

            this.showActiveCallUI(receiver.name, receiver.avatar, callType, 'Calling...');
        } catch (e) {
            console.error('Failed to initiate call:', e);
            this.cleanup();
        }
    }

    createPeerConnection() {
        this.pc = new RTCPeerConnection(this.iceServers);

        this.pc.onicecandidate = (event) => {
            if (event.candidate && this.currentCall) {
                socket.emit('ice_candidate', {
                    target_id: this.currentCall.targetId,
                    candidate: event.candidate
                });
            }
        };

        this.pc.ontrack = (event) => {
            this.remoteStream = event.streams[0];
            const remoteVid = document.getElementById('remote-video');
            if (remoteVid) {
                remoteVid.srcObject = this.remoteStream;
            }
        };

        this.pc.onconnectionstatechange = () => {
            if (this.pc) {
                console.log('ICE Connection state:', this.pc.connectionState);
                if (this.pc.connectionState === 'connected') {
                    this.onCallConnected();
                } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
                    this.endCall('ended');
                }
            }
        };
    }

    // Handle incoming call offer from peer
    onIncomingCall(data) {
        this.currentCall = {
            targetId: data.caller_id,
            targetName: data.caller_name,
            targetAvatar: data.caller_avatar,
            callType: data.call_type,
            offer: data.offer,
            isCaller: false
        };

        this.playRingtone();

        const modal = document.getElementById('modal-incoming-call');
        document.getElementById('incoming-caller-name').textContent = data.caller_name;
        const handleEl = document.getElementById('incoming-caller-handle');
        if (handleEl) handleEl.textContent = `@${data.caller_username || 'user'}`;
        if (typeof updateAvatarElement === 'function') {
            updateAvatarElement(document.getElementById('incoming-avatar'), data.caller_avatar);
        }

        const badge = document.getElementById('incoming-call-type-badge');
        if (data.call_type === 'video') {
            badge.innerHTML = `<i class="fa-solid fa-video"></i> Incoming Video Call`;
        } else {
            badge.innerHTML = `<i class="fa-solid fa-phone"></i> Incoming Voice Call`;
        }

        modal.classList.remove('hidden');
    }

    // Accept Incoming Call
    async acceptCall() {
        this.stopRingtone();
        document.getElementById('modal-incoming-call').classList.add('hidden');

        if (!this.currentCall) return;

        try {
            await this.getMedia(this.currentCall.callType);
            this.createPeerConnection();

            this.localStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.localStream);
            });

            await this.pc.setRemoteDescription(new RTCSessionDescription(this.currentCall.offer));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            socket.emit('answer_call', {
                caller_id: this.currentCall.targetId,
                answer: answer
            });

            this.showActiveCallUI(this.currentCall.targetName, this.currentCall.targetAvatar, this.currentCall.callType, 'Connecting...');
            this.onCallConnected();
        } catch (e) {
            console.error('Failed to accept call:', e);
            this.cleanup();
        }
    }

    // Handle Call Answered
    async onCallAnswered(data) {
        if (this.pc) {
            await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            this.onCallConnected();
        }
    }

    // Handle ICE Candidate
    async onIceCandidate(data) {
        if (this.pc && data.candidate) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
                console.error('Error adding ICE candidate:', e);
            }
        }
    }

    onCallConnected() {
        this.stopRingtone();
        const statusEl = document.getElementById('audio-call-status');
        if (statusEl) statusEl.textContent = 'Connected';
        this.startCallTimer();
    }

    startCallTimer() {
        if (this.callTimer) return;
        this.callSeconds = 0;
        this.callTimer = setInterval(() => {
            this.callSeconds++;
            const mins = String(Math.floor(this.callSeconds / 60)).padStart(2, '0');
            const secs = String(this.callSeconds % 60).padStart(2, '0');
            const formatted = `${mins}:${secs}`;

            const audioTimer = document.getElementById('audio-call-status');
            const videoTimer = document.getElementById('video-call-timer');
            if (audioTimer) audioTimer.textContent = formatted;
            if (videoTimer) videoTimer.textContent = formatted;
        }, 1000);
    }

    showActiveCallUI(name, avatar, callType, statusText) {
        if (callType === 'video') {
            const modal = document.getElementById('modal-video-call');
            document.getElementById('video-call-name').textContent = name;
            const fallbackAvatar = document.getElementById('video-fallback-avatar');
            if (fallbackAvatar && typeof updateAvatarElement === 'function') {
                updateAvatarElement(fallbackAvatar, avatar);
            }
            modal.classList.remove('hidden');
        } else {
            const modal = document.getElementById('modal-audio-call');
            document.getElementById('audio-call-name').textContent = name;
            document.getElementById('audio-call-status').textContent = statusText;
            const audioAvatar = document.getElementById('audio-call-avatar');
            if (audioAvatar && typeof updateAvatarElement === 'function') {
                updateAvatarElement(audioAvatar, avatar);
            }
            modal.classList.remove('hidden');
        }
    }

    toggleMute() {
        if (!this.localStream) return;
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
            this.isMuted = !this.isMuted;
            audioTrack.enabled = !this.isMuted;
            const btnAudio = document.getElementById('btn-audio-mute');
            const btnVideo = document.getElementById('btn-video-mute');
            const icon = this.isMuted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
            if (btnAudio) btnAudio.innerHTML = `<i class="${icon}"></i>`;
            if (btnVideo) btnVideo.innerHTML = `<i class="${icon}"></i>`;
            if (btnAudio) btnAudio.classList.toggle('active', this.isMuted);
            if (btnVideo) btnVideo.classList.toggle('active', this.isMuted);

            if (this.currentCall) {
                socket.emit('toggle_audio', {
                    target_id: this.currentCall.targetId,
                    is_muted: this.isMuted
                });
            }
        }
    }

    toggleCamera() {
        if (!this.localStream) return;
        const videoTrack = this.localStream.getVideoTracks()[0];
        if (videoTrack) {
            this.isVideoOff = !this.isVideoOff;
            videoTrack.enabled = !this.isVideoOff;
            const btn = document.getElementById('btn-video-cam');
            if (btn) {
                btn.innerHTML = `<i class="${this.isVideoOff ? 'fa-solid fa-video-slash' : 'fa-solid fa-video'}"></i>`;
                btn.classList.toggle('active', this.isVideoOff);
            }
            if (this.currentCall) {
                socket.emit('toggle_video', {
                    target_id: this.currentCall.targetId,
                    is_video_off: this.isVideoOff
                });
            }
        }
    }

    toggleSpeaker() {
        const btn = document.getElementById('btn-audio-speaker');
        if (btn) {
            btn.classList.toggle('active');
            showToast(btn.classList.contains('active') ? 'Speaker enabled' : 'Earpiece enabled');
        }
    }

    endCall(status = 'completed') {
        this.stopRingtone();
        if (this.currentCall) {
            socket.emit('end_call', {
                caller_id: this.currentCall.isCaller ? currentUser.id : this.currentCall.targetId,
                receiver_id: this.currentCall.isCaller ? this.currentCall.targetId : currentUser.id,
                call_type: this.currentCall.callType,
                duration: this.callSeconds,
                status: this.callSeconds > 0 ? 'completed' : 'missed'
            });
        }
        this.cleanup();
    }

    rejectCall() {
        this.stopRingtone();
        if (this.currentCall) {
            socket.emit('reject_call', {
                caller_id: this.currentCall.targetId,
                receiver_id: currentUser.id,
                call_type: this.currentCall.callType
            });
        }
        this.cleanup();
    }

    cleanup() {
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }
        this.callSeconds = 0;
        this.stopRingtone();

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        document.getElementById('modal-incoming-call').classList.add('hidden');
        document.getElementById('modal-audio-call').classList.add('hidden');
        document.getElementById('modal-video-call').classList.add('hidden');

        this.currentCall = null;
        this.isMuted = false;
        this.isVideoOff = false;

        // Reload calls list
        if (typeof loadCallsHistory === 'function') {
            loadCallsHistory();
        }
    }
}

const webrtc = new WebRTCService();
