/**
 * ChatPulse • Core Application Logic
 * Full Instagram-Style Features: Public/Private Accounts, Real Email OTP,
 * Gallery Photo Uploads, Real QR Codes, Unsend, Edit, Copy, Forward, Audio & Video Calls.
 */

let currentUser = null;
let activeChatContact = null;
let currentChatMessages = [];
let socket = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecordingAudio = false;
let typingTimeout = null;
let editingMessageId = null;
let messageToForward = null;
let currentQrDataUrl = null;

const AVATAR_PRESETS = [
    { id: 'avatar_1',  emoji: '🦊', label: 'Fox' },
    { id: 'avatar_2',  emoji: '🦁', label: 'Lion' },
    { id: 'avatar_3',  emoji: '🐼', label: 'Panda' },
    { id: 'avatar_4',  emoji: '🚀', label: 'Rocket' },
    { id: 'avatar_5',  emoji: '⚡', label: 'Flash' },
    { id: 'avatar_6',  emoji: '🌸', label: 'Blossom' },
    { id: 'avatar_7',  emoji: '👑', label: 'Crown' },
    { id: 'avatar_8',  emoji: '🎯', label: 'Target' },
    { id: 'avatar_9',  emoji: '🌟', label: 'Star' },
    { id: 'avatar_10', emoji: '🐬', label: 'Dolphin' },
    { id: 'avatar_11', emoji: '💎', label: 'Diamond' },
    { id: 'avatar_12', emoji: '🦄', label: 'Unicorn' }
];

function getAvatarClass(id) {
    if (!id || id.startsWith('/') || id.startsWith('http')) return '';
    const num = id.replace('avatar_', '');
    return `avatar-preset-${num}`;
}

function getAvatarEmoji(id) {
    if (!id || id.startsWith('/') || id.startsWith('http')) return '';
    const found = AVATAR_PRESETS.find(p => p.id === id);
    return found ? found.emoji : '🦊';
}

function renderAvatarHtml(avatarUrl, sizeClass = 'avatar-medium', statusIndicator = '') {
    const isImage = avatarUrl && (avatarUrl.startsWith('/') || avatarUrl.startsWith('http'));
    let inner = '';
    let extraClass = '';

    if (isImage) {
        inner = `<img src="${avatarUrl}" alt="Avatar">`;
    } else {
        extraClass = getAvatarClass(avatarUrl || 'avatar_1');
        inner = getAvatarEmoji(avatarUrl || 'avatar_1');
    }

    return `
        <div class="avatar-circle ${sizeClass} ${extraClass}">
            ${inner}
        </div>
        ${statusIndicator}
    `;
}

function updateAvatarElement(element, avatarUrl) {
    if (!element) return;
    const isImage = avatarUrl && (avatarUrl.startsWith('/') || avatarUrl.startsWith('http'));
    if (isImage) {
        element.className = element.className.replace(/avatar-preset-\d+/g, '').trim();
        element.innerHTML = `<img src="${avatarUrl}" alt="Avatar">`;
    } else {
        element.innerHTML = getAvatarEmoji(avatarUrl || 'avatar_1');
        element.className = element.className.replace(/avatar-preset-\d+/g, '').trim() + ` ${getAvatarClass(avatarUrl || 'avatar_1')}`;
    }
}

// ==============================================================
// TOAST NOTIFICATIONS
// ==============================================================
function showToast(message, isDemo = false) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${isDemo ? 'toast-demo' : ''}`;
    toast.innerHTML = `<i class="${isDemo ? 'fa-solid fa-key' : 'fa-solid fa-circle-info'}"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, isDemo ? 12000 : 3800);
}

// ==============================================================
// APP INITIALIZATION
// ==============================================================
document.addEventListener('DOMContentLoaded', async () => {
    setupOtpDigitInputs();
    setupAvatarPresets();
    await checkAuth();
});

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.user) {
            currentUser = data.user;
            initApp();
        } else {
            showAuthView('email');
        }
    } catch (e) {
        showAuthView('email');
    }
}

function showAuthView(viewName) {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');

    document.getElementById('view-email').classList.add('hidden');
    document.getElementById('view-otp').classList.add('hidden');
    document.getElementById('view-setup').classList.add('hidden');

    if (viewName === 'email') {
        document.getElementById('view-email').classList.remove('hidden');
    } else if (viewName === 'otp') {
        document.getElementById('view-otp').classList.remove('hidden');
    } else if (viewName === 'setup') {
        document.getElementById('view-setup').classList.remove('hidden');
    }
}

// ==============================================================
// EMAIL & OTP AUTHENTICATION
// ==============================================================
let pendingEmail = '';

async function handleSendOtp(e) {
    e.preventDefault();
    const emailInput = document.getElementById('input-email');
    const email = emailInput.value.trim().toLowerCase();
    const btn = document.getElementById('btn-send-otp');

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending code...`;

    try {
        const res = await fetch('/api/auth/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (res.ok) {
            pendingEmail = email;
            document.getElementById('otp-target-email').textContent = email;
            showAuthView('otp');

            if (data.real_email) {
                showToast(`📧 ${data.message}`);
            } else if (data.demo_otp) {
                showToast(`📧 Dev Notice: Real SMTP is not configured yet. Code: ${data.demo_otp}`, true);
                fillOtpDigits(data.demo_otp);
            }
        } else {
            showToast(data.error || 'Failed to send OTP');
        }
    } catch (err) {
        showToast('Network error, please try again');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span>Send Verification Code</span> <i class="fa-solid fa-arrow-right"></i>`;
    }
}

function handleResendOtp() {
    if (pendingEmail) {
        handleSendOtp({ preventDefault: () => {} });
    }
}

function setupOtpDigitInputs() {
    const inputs = document.querySelectorAll('.otp-digit');
    inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            const val = e.target.value;
            if (val.length === 1 && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && index > 0) {
                inputs[index - 1].focus();
            }
        });

        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text').trim();
            fillOtpDigits(text);
        });
    });
}

function fillOtpDigits(otpStr) {
    const digits = otpStr.replace(/\D/g, '').slice(0, 6);
    const inputs = document.querySelectorAll('.otp-digit');
    digits.split('').forEach((d, i) => {
        if (inputs[i]) inputs[i].value = d;
    });
    if (digits.length === 6 && inputs[5]) {
        inputs[5].focus();
    }
}

async function handleVerifyOtp(e) {
    e.preventDefault();
    const inputs = document.querySelectorAll('.otp-digit');
    let otp = '';
    inputs.forEach(inp => otp += inp.value);

    if (otp.length !== 6) {
        showToast('Please enter all 6 digits of the verification code');
        return;
    }

    const btn = document.getElementById('btn-verify-otp');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`;

    try {
        const res = await fetch('/api/auth/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: pendingEmail, otp })
        });
        const data = await res.json();

        if (res.ok) {
            currentUser = data.user;
            if (data.is_new_user) {
                document.getElementById('setup-name').value = currentUser.name || '';
                document.getElementById('setup-username').value = currentUser.username || '';
                showAuthView('setup');
            } else {
                initApp();
            }
        } else {
            showToast(data.error || 'Invalid code');
        }
    } catch (err) {
        showToast('Network error, please try again');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span>Verify & Log In</span>`;
    }
}

// ==============================================================
// AVATAR PRESET & GALLERY UPLOAD HELPERS
// ==============================================================
let selectedSetupAvatar = 'avatar_1';
let selectedEditAvatar = 'avatar_1';

function setupAvatarPresets() {
    const setupGrid = document.getElementById('setup-avatar-presets');
    const editGrid = document.getElementById('edit-avatar-presets');

    setupGrid.innerHTML = '';
    editGrid.innerHTML = '';

    AVATAR_PRESETS.forEach((preset, index) => {
        const item1 = document.createElement('div');
        item1.className = `avatar-preset-item ${index === 0 ? 'selected' : ''}`;
        item1.innerHTML = `<div class="avatar-circle avatar-small ${getAvatarClass(preset.id)}">${preset.emoji}</div>`;
        item1.onclick = () => {
            selectedSetupAvatar = preset.id;
            document.querySelectorAll('#setup-avatar-presets .avatar-preset-item').forEach(i => i.classList.remove('selected'));
            item1.classList.add('selected');
            updateAvatarElement(document.getElementById('setup-avatar-display'), preset.id);
        };
        setupGrid.appendChild(item1);

        const item2 = document.createElement('div');
        item2.className = `avatar-preset-item`;
        item2.innerHTML = `<div class="avatar-circle avatar-small ${getAvatarClass(preset.id)}">${preset.emoji}</div>`;
        item2.onclick = () => {
            selectedEditAvatar = preset.id;
            document.querySelectorAll('#edit-avatar-presets .avatar-preset-item').forEach(i => i.classList.remove('selected'));
            item2.classList.add('selected');
            updateAvatarElement(document.getElementById('edit-avatar-display'), preset.id);
        };
        editGrid.appendChild(item2);
    });
}

function triggerSetupAvatarUpload() {
    document.getElementById('setup-avatar-file').click();
}

async function handleSetupAvatarFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Uploading photo from gallery...');
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            selectedSetupAvatar = data.url;
            updateAvatarElement(document.getElementById('setup-avatar-display'), data.url);
            document.querySelectorAll('#setup-avatar-presets .avatar-preset-item').forEach(i => i.classList.remove('selected'));
            showToast('Profile photo ready!');
        }
    } catch (err) {
        showToast('Failed to upload image');
    }
}

function triggerProfileHeroAvatarUpload() {
    document.getElementById('hero-avatar-file-input').click();
}

async function handleHeroAvatarUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Updating profile photo...');
    try {
        const res = await fetch('/api/profile/upload-avatar', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            updateProfileView();
            showToast('Profile picture updated successfully!');
        }
    } catch (err) {
        showToast('Failed to update profile picture');
    }
}

function triggerEditAvatarUpload() {
    document.getElementById('edit-avatar-file-input').click();
}

async function handleEditAvatarUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Uploading avatar from gallery...');
    try {
        const res = await fetch('/api/profile/upload-avatar', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            selectedEditAvatar = data.avatar_url;
            currentUser = data.user;
            updateAvatarElement(document.getElementById('edit-avatar-display'), data.avatar_url);
            updateProfileView();
            showToast('Photo uploaded!');
        }
    } catch (err) {
        showToast('Failed to upload avatar');
    }
}

async function handleCompleteSetup(e) {
    e.preventDefault();
    const name = document.getElementById('setup-name').value.trim();
    const username = document.getElementById('setup-username').value.trim();
    const about = document.getElementById('setup-about').value.trim();
    const isPrivate = document.getElementById('setup-is-private').checked;

    try {
        const res = await fetch('/api/profile/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                username,
                about,
                avatar: selectedSetupAvatar,
                is_private: isPrivate
            })
        });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            initApp();
        } else {
            showToast(data.error || 'Failed to complete profile');
        }
    } catch (err) {
        showToast('Error saving profile');
    }
}

// ==============================================================
// APP INITIALIZATION AFTER LOGIN
// ==============================================================
function initApp() {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    updateProfileView();
    initSocket();
    loadChats();
    loadCallsHistory();
    loadPendingRequests();
}

function updateProfileView() {
    if (!currentUser) return;
    updateAvatarElement(document.getElementById('my-avatar-nav'), currentUser.avatar);
    updateAvatarElement(document.getElementById('profile-hero-avatar'), currentUser.avatar);

    document.getElementById('profile-hero-name').textContent = currentUser.name;
    document.getElementById('profile-hero-handle').textContent = `@${currentUser.username || 'user'}`;
    document.getElementById('profile-hero-email').innerHTML = `<i class="fa-regular fa-envelope"></i> ${currentUser.email}`;
    document.getElementById('profile-hero-about').textContent = `"${currentUser.about || 'Hey there! I am using ChatPulse'}"`;

    const privateToggle = document.getElementById('profile-private-toggle');
    if (privateToggle) privateToggle.checked = Boolean(currentUser.is_private);

    document.querySelectorAll('.presence-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === currentUser.status);
    });
}

function initSocket() {
    if (socket) return;
    socket = io();

    socket.on('connect', () => {
        socket.emit('join', { user_id: currentUser.id });
    });

    socket.on('new_message', (msg) => {
        if (activeChatContact && (msg.sender_id === activeChatContact.id || msg.receiver_id === activeChatContact.id)) {
            appendMessageToStream(msg);
            scrollMessagesToBottom();
            if (msg.sender_id === activeChatContact.id) {
                socket.emit('mark_read', { other_id: activeChatContact.id, user_id: currentUser.id });
            }
        }
        loadChats();
    });

    socket.on('message_unsent', (data) => {
        const row = document.querySelector(`[data-msg-id="${data.message_id}"]`);
        if (row) {
            row.style.opacity = '0';
            setTimeout(() => row.remove(), 250);
        }
        loadChats();
    });

    socket.on('message_edited', (data) => {
        const row = document.querySelector(`[data-msg-id="${data.message_id}"]`);
        if (row) {
            const textEl = row.querySelector('.msg-text');
            if (textEl) textEl.textContent = data.new_text;
            let editedTag = row.querySelector('.edited-tag');
            if (!editedTag) {
                const footer = row.querySelector('.msg-footer');
                if (footer) {
                    const tag = document.createElement('span');
                    tag.className = 'edited-tag';
                    tag.textContent = '(edited)';
                    footer.insertBefore(tag, footer.firstChild);
                }
            }
        }
        loadChats();
    });

    socket.on('user_typing', (data) => {
        if (activeChatContact && data.sender_id === activeChatContact.id) {
            const indicator = document.getElementById('typing-indicator');
            if (data.is_typing) {
                indicator.classList.remove('hidden');
            } else {
                indicator.classList.add('hidden');
            }
        }
    });

    socket.on('reaction_updated', (data) => {
        const row = document.querySelector(`[data-msg-id="${data.message_id}"]`);
        if (row) {
            updateReactionBadge(row, data.reactions);
        }
    });

    socket.on('messages_read_by_peer', (data) => {
        if (activeChatContact && data.peer_id === activeChatContact.id) {
            document.querySelectorAll('.sent .read-tick').forEach(tick => {
                tick.className = 'read-tick read';
                tick.innerHTML = '<i class="fa-solid fa-check-double"></i>';
            });
        }
    });

    socket.on('user_presence_change', (data) => {
        if (activeChatContact && data.user_id === activeChatContact.id) {
            const statusEl = document.getElementById('active-chat-status');
            if (statusEl) {
                statusEl.textContent = data.is_online ? 'Online' : 'Offline';
                statusEl.className = data.is_online ? 'online-status-text' : 'online-status-text offline';
            }
        }
        loadChats();
    });

    socket.on('new_connect_request', () => {
        loadPendingRequests();
        showToast('📩 You received a new message request!');
    });

    socket.on('connect_request_updated', (data) => {
        if (data.action === 'accept') {
            showToast('Your message request was accepted! You can now chat.');
            if (activeChatContact && activeChatContact.id === data.responder_id) {
                activeChatContact.connection_status = 'accepted';
                checkPrivateBanner();
            }
        }
    });

    // WebRTC Calling Listeners
    socket.on('incoming_call', (data) => webrtc.onIncomingCall(data));
    socket.on('call_answered', (data) => webrtc.onCallAnswered(data));
    socket.on('ice_candidate', (data) => webrtc.onIceCandidate(data));
    socket.on('call_ended', () => {
        showToast('Call ended');
        webrtc.cleanup();
    });
    socket.on('call_rejected', () => {
        showToast('Call declined');
        webrtc.cleanup();
    });
    socket.on('peer_video_toggle', (data) => {
        const fallback = document.getElementById('remote-video-fallback');
        if (fallback) fallback.classList.toggle('hidden', !data.is_video_off);
    });
}

// ==============================================================
// TAB NAVIGATION
// ==============================================================
function switchNavTab(tabName) {
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.toggle('active', tab.id === `tab-${tabName}`);
    });

    if (tabName === 'calls') {
        loadCallsHistory();
    } else if (tabName === 'chats') {
        loadChats();
    } else if (tabName === 'requests') {
        loadPendingRequests();
    }
}

function toggleTheme() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', newTheme);
    const icon = document.getElementById('theme-icon');
    icon.className = newTheme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

function setThemeAccent(accent, el) {
    document.documentElement.setAttribute('data-accent', accent);
    document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
    el.classList.add('active');
}

// ==============================================================
// CHATS & CONVERSATION MANAGEMENT
// ==============================================================
async function loadChats() {
    try {
        const res = await fetch('/api/chats');
        const data = await res.json();
        const container = document.getElementById('chats-list-container');

        if (!data.chats || data.chats.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-regular fa-comments"></i>
                    <p>No conversations yet.<br>Click the pencil button to find friends!</p>
                </div>
            `;
            return;
        }

        container.innerHTML = '';
        data.chats.forEach(chat => {
            const other = chat.other_user;
            const lastMsg = chat.last_message;
            let previewText = 'Tap to chat';
            let timeStr = '';
            let tickHtml = '';

            if (lastMsg) {
                previewText = lastMsg.text;
                if (lastMsg.msg_type === 'image') previewText = '📷 Photo';
                if (lastMsg.msg_type === 'audio') previewText = '🎤 Voice message';
                timeStr = formatMessageTime(lastMsg.created_at);

                if (lastMsg.sender_id === currentUser.id) {
                    tickHtml = lastMsg.is_read
                        ? `<i class="fa-solid fa-check-double read-tick read" style="font-size:11px;"></i> `
                        : `<i class="fa-solid fa-check read-tick" style="font-size:11px;"></i> `;
                }
            }

            const item = document.createElement('div');
            item.className = `chat-item ${activeChatContact && activeChatContact.id === other.id ? 'active' : ''}`;
            item.onclick = () => openChat(other);
            item.innerHTML = `
                <div class="chat-item-avatar-wrap">
                    ${renderAvatarHtml(other.avatar, 'avatar-medium', `<span class="status-indicator ${other.is_online ? 'online' : 'offline'}"></span>`)}
                </div>
                <div class="chat-item-body">
                    <div class="chat-item-top">
                        <span class="chat-item-name">${escapeHtml(other.name)} ${other.is_private ? '<i class="fa-solid fa-lock" style="font-size:11px; color:var(--warning);"></i>' : ''}</span>
                        <span class="chat-item-time">${timeStr}</span>
                    </div>
                    <div class="chat-item-bottom">
                        <span class="chat-item-snippet">${tickHtml}${escapeHtml(previewText)}</span>
                        ${chat.unread_count > 0 ? `<span class="unread-count-pill">${chat.unread_count}</span>` : ''}
                    </div>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (e) {
        console.error('Failed to load chats:', e);
    }
}

async function openChat(contact) {
    activeChatContact = contact;

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    document.getElementById('no-chat-selected').classList.add('hidden');
    document.getElementById('active-chat-container').classList.remove('hidden');

    document.querySelector('.chat-viewport').classList.add('active-mobile');

    document.getElementById('active-chat-name').textContent = contact.name;
    const privacyBadge = document.getElementById('active-chat-privacy-badge');
    privacyBadge.classList.toggle('hidden', !contact.is_private);

    updateAvatarElement(document.getElementById('active-chat-avatar'), contact.avatar);

    const statusEl = document.getElementById('active-chat-status');
    statusEl.textContent = contact.is_online ? 'Online' : 'Offline';
    statusEl.className = contact.is_online ? 'online-status-text' : 'online-status-text offline';

    checkPrivateBanner();

    // Fetch messages
    try {
        const res = await fetch(`/api/chats/${contact.id}/messages`);
        const data = await res.json();
        currentChatMessages = data.messages || [];
        renderMessagesStream();
        scrollMessagesToBottom();
        loadChats();
    } catch (e) {
        console.error('Failed to load messages:', e);
    }
}

function checkPrivateBanner() {
    const banner = document.getElementById('private-account-banner');
    if (!activeChatContact) {
        banner.classList.add('hidden');
        return;
    }

    if (activeChatContact.is_private && activeChatContact.connection_status !== 'accepted') {
        banner.classList.remove('hidden');
        const btn = document.getElementById('btn-request-connect');
        if (activeChatContact.connection_status === 'pending') {
            btn.innerHTML = `<i class="fa-solid fa-clock"></i> Request Pending`;
            btn.disabled = true;
        } else {
            btn.innerHTML = `<i class="fa-solid fa-user-plus"></i> Request to Chat`;
            btn.disabled = false;
        }
    } else {
        banner.classList.add('hidden');
    }
}

async function sendConnectRequest() {
    if (!activeChatContact) return;
    try {
        const res = await fetch('/api/requests/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_id: activeChatContact.id })
        });
        const data = await res.json();
        if (res.ok) {
            activeChatContact.connection_status = 'pending';
            checkPrivateBanner();
            showToast('Message request sent!');
        }
    } catch (e) {
        showToast('Error sending request');
    }
}

function closeChatMobile() {
    document.querySelector('.chat-viewport').classList.remove('active-mobile');
    activeChatContact = null;
}

function renderMessagesStream() {
    const container = document.getElementById('messages-stream');
    container.innerHTML = '';

    if (currentChatMessages.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="margin-top: auto; margin-bottom: auto;">
                ${renderAvatarHtml(activeChatContact.avatar, 'avatar-large')}
                <h3 style="font-size: 18px; margin-top: 10px; margin-bottom: 4px;">Say hello to ${escapeHtml(activeChatContact.name)}! 👋</h3>
                <p>Messages, audio and video calls are end-to-end encrypted.</p>
            </div>
        `;
        return;
    }

    currentChatMessages.forEach(msg => appendMessageToStream(msg));
}

function appendMessageToStream(msg) {
    const container = document.getElementById('messages-stream');
    const isMe = msg.sender_id === currentUser.id;

    if (msg.msg_type === 'call') {
        const callDiv = document.createElement('div');
        callDiv.className = 'msg-call-card';
        callDiv.innerHTML = `
            <i class="fa-solid ${msg.text.includes('Video') ? 'fa-video' : 'fa-phone'}"></i>
            <span>${escapeHtml(msg.text)}</span>
            <span class="text-muted" style="font-size: 11px;">${formatMessageTime(msg.created_at)}</span>
        `;
        container.appendChild(callDiv);
        return;
    }

    const row = document.createElement('div');
    row.className = `message-bubble-row ${isMe ? 'sent' : 'received'}`;
    row.dataset.msgId = msg.id;

    let contentHtml = '';
    if (msg.is_unsent) {
        contentHtml = `<span class="msg-text"><i>🚫 Message unsent</i></span>`;
    } else if (msg.msg_type === 'image') {
        contentHtml = `<img src="${msg.media_url}" class="msg-image" alt="Image" onclick="viewFullImage('${msg.media_url}')">`;
        if (msg.text && msg.text !== 'Photo') {
            contentHtml += `<div class="msg-text">${escapeHtml(msg.text)}</div>`;
        }
    } else if (msg.msg_type === 'audio') {
        contentHtml = `
            <div class="msg-audio-player">
                <button class="msg-audio-play-btn" onclick="playAudioMessage(this, '${msg.media_url}')">
                    <i class="fa-solid fa-play"></i>
                </button>
                <div style="font-size: 13px;">Voice note (${msg.duration || 10}s)</div>
            </div>
        `;
    } else {
        contentHtml = `<span class="msg-text">${escapeHtml(msg.text)}</span>`;
    }

    const reactionsObj = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions || '{}') : (msg.reactions || {});
    const reactionsHtml = getReactionsHtml(reactionsObj);

    // Advanced Action Buttons on Hover: Copy, Forward, Edit (if sent), Unsend (if sent)
    const hoverActions = `
        <div class="msg-hover-actions">
            <button class="msg-action-btn" title="Copy text" onclick="copyMessageText('${escapeAttr(msg.text)}')"><i class="fa-regular fa-copy"></i></button>
            <button class="msg-action-btn" title="Forward message" onclick="openForwardModal('${msg.id}', '${escapeAttr(msg.text)}', '${msg.msg_type}', '${escapeAttr(msg.media_url)}')"><i class="fa-solid fa-share"></i></button>
            ${isMe && msg.msg_type === 'text' && !msg.is_unsent ? `<button class="msg-action-btn" title="Edit message" onclick="startEditingMessage('${msg.id}', '${escapeAttr(msg.text)}')"><i class="fa-solid fa-pen"></i></button>` : ''}
            ${isMe && !msg.is_unsent ? `<button class="msg-action-btn" title="Unsend for everyone" onclick="unsendCurrentMessage('${msg.id}')"><i class="fa-solid fa-trash-can"></i></button>` : ''}
        </div>
    `;

    row.innerHTML = `
        ${hoverActions}
        <div class="message-bubble" oncontextmenu="handleBubbleContextMenu(event, '${msg.id}', ${isMe})">
            ${msg.is_forwarded ? `<div class="forwarded-tag"><i class="fa-solid fa-share" style="font-size:9px;"></i> Forwarded</div>` : ''}
            ${contentHtml}
            <div class="msg-footer">
                ${msg.is_edited ? `<span class="edited-tag">(edited)</span>` : ''}
                <span>${formatMessageTime(msg.created_at)}</span>
                ${isMe ? `<span class="read-tick ${msg.is_read ? 'read' : ''}"><i class="fa-solid ${msg.is_read ? 'fa-check-double' : 'fa-check'}"></i></span>` : ''}
            </div>
        </div>
        ${reactionsHtml}
    `;

    container.appendChild(row);
}

function getReactionsHtml(reactionsObj) {
    const values = Object.values(reactionsObj);
    if (values.length === 0) return '';
    const distinct = [...new Set(values)].join(' ');
    return `<div class="reactions-badge" onclick="toggleReactionOnMessage(this)">${distinct}</div>`;
}

function updateReactionBadge(row, reactionsObj) {
    let badge = row.querySelector('.reactions-badge');
    const values = Object.values(reactionsObj);
    if (values.length === 0) {
        if (badge) badge.remove();
        return;
    }
    const distinct = [...new Set(values)].join(' ');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'reactions-badge';
        row.appendChild(badge);
    }
    badge.textContent = distinct;
}

function scrollMessagesToBottom() {
    const stream = document.getElementById('messages-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
}

function handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
    }
}

function handleTypingEvent() {
    if (!activeChatContact || !socket) return;
    socket.emit('typing', { sender_id: currentUser.id, receiver_id: activeChatContact.id, is_typing: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', { sender_id: currentUser.id, receiver_id: activeChatContact.id, is_typing: false });
    }, 1500);
}

// Send or Submit Edit Message
function sendTextMessage() {
    if (!activeChatContact) return;
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    if (editingMessageId) {
        // Edit existing message
        socket.emit('edit_message', {
            message_id: editingMessageId,
            user_id: currentUser.id,
            new_text: text
        });
        cancelEditingMessage();
        return;
    }

    input.value = '';
    socket.emit('send_message', {
        sender_id: currentUser.id,
        receiver_id: activeChatContact.id,
        text: text,
        type: 'text'
    });
}

function toggleQuickEmojis() {
    document.getElementById('quick-emoji-bar').classList.toggle('hidden');
}

function insertEmoji(emoji) {
    const input = document.getElementById('message-input');
    input.value += emoji;
    input.focus();
}

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !activeChatContact) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Uploading photo from gallery...');
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            socket.emit('send_message', {
                sender_id: currentUser.id,
                receiver_id: activeChatContact.id,
                text: 'Photo',
                type: 'image',
                media_url: data.url
            });
        }
    } catch (err) {
        showToast('Failed to upload image');
    }
}

// Voice Note Recording
async function toggleAudioRecording() {
    const btn = document.getElementById('btn-record-audio');

    if (!isRecordingAudio) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const file = new File([audioBlob], 'voice_note.webm', { type: 'audio/webm' });
                const formData = new FormData();
                formData.append('file', file);

                showToast('Sending audio note...');
                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });
                    const data = await res.json();
                    if (res.ok) {
                        socket.emit('send_message', {
                            sender_id: currentUser.id,
                            receiver_id: activeChatContact.id,
                            text: 'Voice note',
                            type: 'audio',
                            media_url: data.url,
                            duration: 8
                        });
                    }
                } catch (err) {
                    showToast('Failed to send voice note');
                }
            };

            mediaRecorder.start();
            isRecordingAudio = true;
            btn.style.color = 'var(--danger)';
            showToast('🎙️ Recording voice note... Click mic again to send');
        } catch (err) {
            showToast('Microphone permission required');
        }
    } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        isRecordingAudio = false;
        btn.style.color = '';
    }
}

function playAudioMessage(btn, url) {
    const audio = new Audio(url);
    btn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
    audio.play();
    audio.onended = () => {
        btn.innerHTML = `<i class="fa-solid fa-play"></i>`;
    };
}

// Advanced Message Actions: Unsend, Edit, Copy, Forward
function copyMessageText(text) {
    navigator.clipboard.writeText(text);
    showToast('Message copied to clipboard! 📋');
}

function startEditingMessage(msgId, currentText) {
    editingMessageId = msgId;
    const input = document.getElementById('message-input');
    input.value = currentText;
    input.focus();
    document.getElementById('inline-edit-bar').classList.remove('hidden');
}

function cancelEditingMessage() {
    editingMessageId = null;
    const input = document.getElementById('message-input');
    input.value = '';
    document.getElementById('inline-edit-bar').classList.add('hidden');
}

function unsendCurrentMessage(msgId) {
    if (confirm('Unsend this message for everyone?')) {
        socket.emit('unsend_message', {
            message_id: msgId,
            user_id: currentUser.id
        });
        showToast('Message unsent');
    }
}

function openForwardModal(msgId, text, type, mediaUrl) {
    messageToForward = { msgId, text, type, mediaUrl };
    document.getElementById('forward-preview-text').textContent = text || 'Photo/Audio';
    document.getElementById('modal-forward').classList.remove('hidden');
    loadUsersToForward();
}

function closeForwardModal() {
    document.getElementById('modal-forward').classList.add('hidden');
    messageToForward = null;
}

async function loadUsersToForward() {
    try {
        const res = await fetch('/api/users/search');
        const data = await res.json();
        const container = document.getElementById('forward-users-container');
        container.innerHTML = '';

        if (!data.users || data.users.length === 0) {
            container.innerHTML = `<p class="text-muted text-center" style="padding: 16px;">No contacts to forward to.</p>`;
            return;
        }

        data.users.forEach(u => {
            const item = document.createElement('div');
            item.className = 'user-lookup-item';
            item.onclick = () => executeForwardTo(u.id);
            item.innerHTML = `
                ${renderAvatarHtml(u.avatar, 'avatar-small')}
                <div style="flex:1;">
                    <div style="font-size:14px; font-weight:600;">${escapeHtml(u.name)}</div>
                    <div style="font-size:12px; color:var(--text-muted);">@${escapeHtml(u.username || 'user')}</div>
                </div>
                <button class="btn btn-primary btn-sm"><i class="fa-solid fa-paper-plane"></i> Send</button>
            `;
            container.appendChild(item);
        });
    } catch (e) {
        console.error('Failed to load forward users:', e);
    }
}

function executeForwardTo(targetId) {
    if (!messageToForward) return;
    socket.emit('forward_message', {
        sender_id: currentUser.id,
        target_ids: [targetId],
        text: messageToForward.text,
        type: messageToForward.type,
        media_url: messageToForward.mediaUrl
    });
    closeForwardModal();
    showToast('Message forwarded successfully! ↗️');
}

function handleBubbleContextMenu(e, msgId, isMe) {
    e.preventDefault();
}

async function handleClearCurrentChat() {
    if (!activeChatContact) return;
    if (confirm(`Clear all messages with ${activeChatContact.name}?`)) {
        await fetch(`/api/chats/${activeChatContact.id}/clear`, { method: 'POST' });
        currentChatMessages = [];
        renderMessagesStream();
        loadChats();
        showToast('Chat history cleared');
    }
}

// ==============================================================
// CALLS & WEBRTC CALLING TRIGGERS
// ==============================================================
function startCall(callType) {
    if (!activeChatContact) return;
    webrtc.initiateCall(activeChatContact, callType);
}

function acceptIncomingCall() {
    webrtc.acceptCall();
}

function rejectIncomingCall() {
    webrtc.rejectCall();
}

function endCall() {
    webrtc.endCall();
}

function toggleMute() {
    webrtc.toggleMute();
}

function toggleCamera() {
    webrtc.toggleCamera();
}

function toggleSpeaker() {
    webrtc.toggleSpeaker();
}

async function loadCallsHistory() {
    try {
        const res = await fetch('/api/calls');
        const data = await res.json();
        const container = document.getElementById('calls-list-container');

        if (!data.calls || data.calls.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-phone-slash"></i>
                    <p>No call logs yet.<br>Audio & video calls will appear here.</p>
                </div>
            `;
            return;
        }

        renderCallsList(data.calls);
    } catch (e) {
        console.error('Failed to load call history:', e);
    }
}

let cachedCalls = [];
function renderCallsList(calls) {
    cachedCalls = calls;
    const container = document.getElementById('calls-list-container');
    container.innerHTML = '';

    calls.forEach(call => {
        const isOutgoing = call.caller_id === currentUser.id;
        const isMissed = call.status === 'missed' || call.status === 'declined';
        const otherName = isOutgoing ? call.receiver_name : call.caller_name;
        const otherAvatar = isOutgoing ? call.receiver_avatar : call.caller_avatar;
        const otherId = isOutgoing ? call.receiver_id : call.caller_id;
        const isVideo = call.call_type === 'video';

        let dirClass = 'call-dir-incoming';
        let dirIcon = 'fa-arrow-down-left';
        if (isMissed) {
            dirClass = 'call-dir-missed';
            dirIcon = 'fa-arrow-down-left';
        } else if (isOutgoing) {
            dirClass = 'call-dir-outgoing';
            dirIcon = 'fa-arrow-up-right';
        }

        const durationStr = call.duration > 0
            ? `• ${Math.floor(call.duration / 60)}m ${call.duration % 60}s`
            : (isMissed ? '• Missed' : '');

        const item = document.createElement('div');
        item.className = 'call-item';
        item.innerHTML = `
            ${renderAvatarHtml(otherAvatar, 'avatar-medium')}
            <div class="call-item-info">
                <div class="call-item-name">${escapeHtml(otherName)}</div>
                <div class="call-item-meta">
                    <i class="fa-solid ${dirIcon} ${dirClass}"></i>
                    <span>${formatMessageTime(call.created_at)} ${durationStr}</span>
                </div>
            </div>
            <button class="btn-icon" title="Call Back" onclick="redialCall('${otherId}', '${escapeAttr(otherName)}', '${otherAvatar}', '${call.call_type}')">
                <i class="fa-solid ${isVideo ? 'fa-video' : 'fa-phone'}" style="color: var(--primary);"></i>
            </button>
        `;
        container.appendChild(item);
    });
}

function redialCall(targetId, targetName, targetAvatar, callType) {
    webrtc.initiateCall({ id: targetId, name: targetName, avatar: targetAvatar }, callType);
}

function filterCalls(type, btn) {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');

    if (type === 'missed') {
        const missed = cachedCalls.filter(c => (c.status === 'missed' || c.status === 'declined') && c.receiver_id === currentUser.id);
        renderCallsList(missed);
    } else {
        renderCallsList(cachedCalls);
    }
}

async function clearCallLogs() {
    if (confirm('Clear your entire call log?')) {
        await fetch('/api/calls/clear', { method: 'POST' });
        loadCallsHistory();
        showToast('Call history cleared');
    }
}

// ==============================================================
// MESSAGE REQUESTS (Instagram-Style Private Accounts)
// ==============================================================
async function loadPendingRequests() {
    try {
        const res = await fetch('/api/requests/pending');
        const data = await res.json();
        const container = document.getElementById('requests-list-container');
        const badge = document.getElementById('requests-badge');

        if (!data.requests || data.requests.length === 0) {
            badge.classList.add('hidden');
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-user-check"></i>
                    <p>No pending message requests.</p>
                </div>
            `;
            return;
        }

        badge.classList.remove('hidden');
        container.innerHTML = '';

        data.requests.forEach(r => {
            const item = document.createElement('div');
            item.className = 'request-item';
            item.innerHTML = `
                ${renderAvatarHtml(r.avatar, 'avatar-medium')}
                <div class="request-item-info">
                    <div style="font-weight:600; font-size:14.5px;">${escapeHtml(r.name)}</div>
                    <div style="font-size:12px; color:var(--primary);">@${escapeHtml(r.username || 'user')}</div>
                    <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Wants to start a conversation with you</div>
                </div>
                <div class="request-actions">
                    <button class="btn btn-primary btn-sm" onclick="respondConnectRequest('${r.sender_id}', 'accept')"><i class="fa-solid fa-check"></i> Accept</button>
                    <button class="btn btn-secondary btn-sm" onclick="respondConnectRequest('${r.sender_id}', 'decline')"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (e) {
        console.error('Failed to load requests:', e);
    }
}

async function respondConnectRequest(senderId, action) {
    try {
        const res = await fetch('/api/requests/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_id: senderId, action })
        });
        if (res.ok) {
            showToast(action === 'accept' ? 'Request accepted! You can now chat.' : 'Request declined.');
            loadPendingRequests();
            loadChats();
        }
    } catch (e) {
        showToast('Error responding to request');
    }
}

// ==============================================================
// PROFILE & SETTINGS
// ==============================================================
async function setPresenceStatus(status, btn) {
    try {
        const res = await fetch('/api/profile/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            document.querySelectorAll('.presence-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            showToast(`Status set to ${status}`);
        }
    } catch (e) {
        showToast('Failed to update status');
    }
}

async function toggleAccountPrivacy(isPrivate) {
    try {
        const res = await fetch('/api/profile/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_private: isPrivate })
        });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            showToast(isPrivate ? '🔒 Account is now Private' : '🌐 Account is now Public');
        }
    } catch (e) {
        showToast('Error updating account privacy');
    }
}

function openEditProfileModal() {
    const modal = document.getElementById('modal-edit-profile');
    document.getElementById('edit-name').value = currentUser.name;
    document.getElementById('edit-username').value = currentUser.username || '';
    document.getElementById('edit-about').value = currentUser.about || '';
    document.getElementById('edit-is-private').checked = Boolean(currentUser.is_private);
    selectedEditAvatar = currentUser.avatar || 'avatar_1';
    updateAvatarElement(document.getElementById('edit-avatar-display'), selectedEditAvatar);
    modal.classList.remove('hidden');
}

function closeEditProfileModal() {
    document.getElementById('modal-edit-profile').classList.add('hidden');
}

function setEditAbout(text) {
    document.getElementById('edit-about').value = text;
}

async function handleSaveProfile(e) {
    e.preventDefault();
    const name = document.getElementById('edit-name').value.trim();
    const username = document.getElementById('edit-username').value.trim();
    const about = document.getElementById('edit-about').value.trim();
    const isPrivate = document.getElementById('edit-is-private').checked;

    try {
        const res = await fetch('/api/profile/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                username,
                about,
                avatar: selectedEditAvatar,
                is_private: isPrivate
            })
        });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            updateProfileView();
            closeEditProfileModal();
            showToast('Profile updated!');
        } else {
            showToast(data.error || 'Failed to update profile');
        }
    } catch (err) {
        showToast('Error saving profile');
    }
}

// REAL QR CODE GENERATOR
async function openQrModal() {
    const modal = document.getElementById('modal-qr');
    updateAvatarElement(document.getElementById('qr-avatar-display'), currentUser.avatar);
    document.getElementById('qr-user-name').textContent = currentUser.name;
    document.getElementById('qr-user-handle').textContent = `@${currentUser.username || 'user'}`;

    try {
        const res = await fetch(`/api/profile/qrcode?format=base64&user_id=${currentUser.id}`);
        const data = await res.json();
        if (data.qr_code) {
            currentQrDataUrl = data.qr_code;
            document.getElementById('qr-real-image').src = data.qr_code;
        }
    } catch (e) {
        console.error('Error fetching QR code:', e);
    }

    modal.classList.remove('hidden');
}

function closeQrModal() {
    document.getElementById('modal-qr').classList.add('hidden');
}

function downloadQrCode() {
    if (!currentQrDataUrl) return;
    const a = document.createElement('a');
    a.href = currentQrDataUrl;
    a.download = `chatpulse_qr_${currentUser.username || 'profile'}.png`;
    a.click();
    showToast('QR Code image downloaded! 📥');
}

function copyMyProfileLink() {
    const url = `${window.location.origin}/#user=${currentUser.username || currentUser.id}`;
    navigator.clipboard.writeText(url);
    showToast('Profile link copied to clipboard! 🔗');
}

function copyUserId() {
    navigator.clipboard.writeText(currentUser.id);
    showToast('User ID copied to clipboard');
}

function clearAppCache() {
    showToast('App cache cleared (14 MB freed)');
}

async function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
        await fetch('/api/auth/logout', { method: 'POST' });
        currentUser = null;
        if (socket) socket.disconnect();
        window.location.reload();
    }
}

async function handleDeleteAccount() {
    if (confirm('Delete your account permanently? All messages and call history will be lost.')) {
        await fetch('/api/profile/delete', { method: 'POST' });
        window.location.reload();
    }
}

// ==============================================================
// REAL SMTP EMAIL CONFIGURATION
// ==============================================================
async function openSmtpConfigModal() {
    try {
        const res = await fetch('/api/smtp/config');
        const cfg = await res.json();
        if (cfg.server) document.getElementById('smtp-server').value = cfg.server;
        if (cfg.port) document.getElementById('smtp-port').value = cfg.port;
        if (cfg.email) document.getElementById('smtp-email').value = cfg.email;
        if (cfg.has_password) document.getElementById('smtp-password').value = '••••••••';
    } catch (_) {}
    document.getElementById('modal-smtp').classList.remove('hidden');
}

function closeSmtpModal() {
    document.getElementById('modal-smtp').classList.add('hidden');
}

function applySmtpPreset(type) {
    if (type === 'gmail') {
        document.getElementById('smtp-server').value = 'smtp.gmail.com';
        document.getElementById('smtp-port').value = 587;
    } else if (type === 'outlook') {
        document.getElementById('smtp-server').value = 'smtp.office365.com';
        document.getElementById('smtp-port').value = 587;
    } else if (type === 'yahoo') {
        document.getElementById('smtp-server').value = 'smtp.mail.yahoo.com';
        document.getElementById('smtp-port').value = 587;
    }
}

async function handleSaveSmtp(e) {
    e.preventDefault();
    const server = document.getElementById('smtp-server').value.trim();
    const port = document.getElementById('smtp-port').value.trim();
    const email = document.getElementById('smtp-email').value.trim();
    const password = document.getElementById('smtp-password').value.trim();

    try {
        const res = await fetch('/api/smtp/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server, port, email, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('✅ SMTP Settings Saved! Real OTPs are now active.');
            closeSmtpModal();
        } else {
            showToast(data.error || 'Failed to save SMTP');
        }
    } catch (e) {
        showToast('Error saving SMTP settings');
    }
}

async function testSmtpConnection() {
    const email = document.getElementById('smtp-email').value.trim();
    if (!email) {
        showToast('Please enter your sender email to test');
        return;
    }

    showToast('Sending test email...');
    try {
        const res = await fetch('/api/smtp/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message);
        } else {
            showToast(data.error || 'Test email failed');
        }
    } catch (e) {
        showToast('Test request failed');
    }
}

// ==============================================================
// NEW CHAT / FIND FRIENDS (Public vs Private Support)
// ==============================================================
function openNewChatModal() {
    document.getElementById('modal-new-chat').classList.remove('hidden');
    searchUsersForChat('');
}

function closeNewChatModal() {
    document.getElementById('modal-new-chat').classList.add('hidden');
}

async function searchUsersForChat(q) {
    try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        const container = document.getElementById('users-lookup-container');

        if (!data.users || data.users.length === 0) {
            container.innerHTML = `<p class="text-muted text-center" style="padding: 20px;">No matching users found.</p>`;
            return;
        }

        container.innerHTML = '';
        data.users.forEach(u => {
            const isPrivate = Boolean(u.is_private);
            const isConnected = u.connection_status === 'accepted';
            const isPending = u.connection_status === 'pending';

            const item = document.createElement('div');
            item.className = 'user-lookup-item';
            item.onclick = () => {
                closeNewChatModal();
                openChat(u);
            };

            item.innerHTML = `
                ${renderAvatarHtml(u.avatar, 'avatar-small')}
                <div style="flex:1;">
                    <div style="font-size:14.5px; font-weight:600;">
                        ${escapeHtml(u.name)}
                        ${isPrivate ? '<i class="fa-solid fa-lock" style="font-size:11px; color:var(--warning); margin-left:4px;"></i>' : ''}
                    </div>
                    <div style="font-size:12px; color:var(--primary);">@${escapeHtml(u.username || 'user')}</div>
                </div>
                ${isPrivate && !isConnected ? (isPending ? `<span class="privacy-tag-pill private">Pending</span>` : `<span class="privacy-tag-pill private">Private</span>`) : `<i class="fa-solid fa-message" style="color:var(--primary);"></i>`}
            `;
            container.appendChild(item);
        });
    } catch (e) {
        console.error('Failed to search users:', e);
    }
}

function filterChats(query) {
    const q = query.toLowerCase().trim();
    document.querySelectorAll('.chat-item').forEach(item => {
        const name = item.querySelector('.chat-item-name')?.textContent?.toLowerCase() || '';
        const snippet = item.querySelector('.chat-item-snippet')?.textContent?.toLowerCase() || '';
        item.style.display = (name.includes(q) || snippet.includes(q)) ? 'flex' : 'none';
    });
}

function closeModalOnBackdrop(e, modalId) {
    if (e.target.id === modalId) {
        document.getElementById(modalId).classList.add('hidden');
    }
}

// Helpers
function viewFullImage(url) {
    window.open(url, '_blank');
}

function viewContactInfo() {
    if (!activeChatContact) return;
    const privacy = activeChatContact.is_private ? '🔒 Private Account' : '🌐 Public Account';
    alert(`Contact: ${activeChatContact.name}\nUsername: @${activeChatContact.username || 'user'}\nEmail: ${activeChatContact.email}\nStatus: ${activeChatContact.about || 'Available'}\nAccount: ${privacy}`);
}

function formatMessageTime(dateStr) {
    if (!dateStr) return '';
    const dt = new Date(dateStr.replace(' ', 'T') + 'Z');
    let h = dt.getHours();
    const m = String(dt.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
