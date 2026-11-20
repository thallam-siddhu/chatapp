import os
import io
import json
import random
import sqlite3
import smtplib
import uuid
import base64
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from flask import Flask, jsonify, render_template, request, session, send_from_directory, send_file
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
import qrcode
from PIL import Image

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'chatpulse-super-secret-key-2026')
app.config['UPLOAD_FOLDER'] = os.path.join(app.root_path, 'static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024  # 32 MB max

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

DB_PATH = os.path.join(app.root_path, 'chatapp.db')
CONFIG_PATH = os.path.join(app.root_path, 'config.json')

# Active online socket users: user_id -> set of socket sids
online_users = {}

# -------------------------------------------------------------
# Configuration & .env Loader
# -------------------------------------------------------------
def load_env():
    env_path = os.path.join(app.root_path, '.env')
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        os.environ[k.strip()] = v.strip().strip('"').strip("'")
        except Exception as e:
            print(f"[ENV] Could not read .env: {e}")

load_env()

def get_smtp_config():
    # Priority: 1. config.json 2. Environment variables
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}

    server = cfg.get('SMTP_SERVER') or os.environ.get('SMTP_SERVER', '')
    port = int(cfg.get('SMTP_PORT') or os.environ.get('SMTP_PORT', 587))
    email = cfg.get('SMTP_EMAIL') or os.environ.get('SMTP_EMAIL', '')
    password = cfg.get('SMTP_PASSWORD') or os.environ.get('SMTP_PASSWORD', '')
    use_ssl = cfg.get('SMTP_USE_SSL', port == 465)

    return {
        'server': server,
        'port': port,
        'email': email,
        'password': password,
        'use_ssl': use_ssl,
        'is_configured': bool(server and email and password)
    }

def save_smtp_config(server, port, email, password, use_ssl=False):
    cfg = {
        'SMTP_SERVER': server.strip(),
        'SMTP_PORT': int(port),
        'SMTP_EMAIL': email.strip(),
        'SMTP_PASSWORD': password.strip(),
        'SMTP_USE_SSL': bool(use_ssl)
    }
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)

    # Also update environment
    for k, v in cfg.items():
        os.environ[k] = str(v)

# -------------------------------------------------------------
# Database Setup & Migrations
# -------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()

        # Users table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE,
                name TEXT NOT NULL,
                avatar TEXT DEFAULT 'avatar_1',
                about TEXT DEFAULT 'Hey there! I am using ChatPulse',
                is_private INTEGER DEFAULT 0,
                status TEXT DEFAULT 'online',
                is_online INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Ensure columns exist if migrating from previous version
        cursor.execute("PRAGMA table_info(users)")
        cols = [r['name'] for r in cursor.fetchall()]
        if 'username' not in cols:
            cursor.execute("ALTER TABLE users ADD COLUMN username TEXT")
        if 'is_private' not in cols:
            cursor.execute("ALTER TABLE users ADD COLUMN is_private INTEGER DEFAULT 0")

        # OTPs table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS otps (
                email TEXT PRIMARY KEY,
                otp TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL
            )
        ''')

        # Follow/Message requests (for Instagram-style private accounts)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS connect_requests (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(sender_id, receiver_id)
            )
        ''')

        # Messages table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                text TEXT NOT NULL,
                msg_type TEXT DEFAULT 'text',
                media_url TEXT,
                duration INTEGER,
                reactions TEXT DEFAULT '{}',
                is_read INTEGER DEFAULT 0,
                is_edited INTEGER DEFAULT 0,
                is_unsent INTEGER DEFAULT 0,
                is_forwarded INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP
            )
        ''')

        cursor.execute("PRAGMA table_info(messages)")
        msg_cols = [r['name'] for r in cursor.fetchall()]
        if 'is_edited' not in msg_cols:
            cursor.execute("ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0")
        if 'is_unsent' not in msg_cols:
            cursor.execute("ALTER TABLE messages ADD COLUMN is_unsent INTEGER DEFAULT 0")
        if 'is_forwarded' not in msg_cols:
            cursor.execute("ALTER TABLE messages ADD COLUMN is_forwarded INTEGER DEFAULT 0")
        if 'updated_at' not in msg_cols:
            cursor.execute("ALTER TABLE messages ADD COLUMN updated_at TIMESTAMP")

        # Calls table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY,
                caller_id TEXT NOT NULL,
                caller_name TEXT NOT NULL,
                caller_avatar TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                receiver_name TEXT NOT NULL,
                receiver_avatar TEXT NOT NULL,
                call_type TEXT NOT NULL,
                status TEXT NOT NULL,
                duration INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        conn.commit()

init_db()

# -------------------------------------------------------------
# Real Email OTP Sender
# -------------------------------------------------------------
def send_real_email_otp(recipient_email, otp_code):
    cfg = get_smtp_config()

    if not cfg['is_configured']:
        err = "SMTP is not configured yet. Please configure your sender email credentials in Email Settings."
        print(f"\n[EMAIL NOTICE] {err}")
        print(f"[DEMO CODE] Verification code for {recipient_email}: {otp_code}\n")
        return False, err, otp_code

    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = f"{otp_code} is your ChatPulse verification code"
        msg['From'] = f"ChatPulse <{cfg['email']}>"
        msg['To'] = recipient_email

        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; }}
                .card {{ max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }}
                .brand {{ text-align: center; margin-bottom: 24px; }}
                .brand h1 {{ color: #0d9488; margin: 0; font-size: 26px; }}
                .brand p {{ color: #64748b; font-size: 14px; margin-top: 4px; }}
                .otp-box {{ background: #f0fdfa; border: 2px dashed #0d9488; border-radius: 12px; text-align: center; padding: 20px; margin: 24px 0; }}
                .otp-number {{ font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0f766e; font-family: monospace; }}
                .notice {{ font-size: 13px; color: #64748b; text-align: center; line-height: 1.5; }}
                .footer {{ text-align: center; font-size: 11px; color: #94a3b8; margin-top: 24px; }}
            </style>
        </head>
        <body>
            <div class="card">
                <div class="brand">
                    <h1>💬 ChatPulse</h1>
                    <p>Real-time Chats, Voice & Video Calls</p>
                </div>
                <p style="font-size: 15px; color: #334155; text-align: center;">Here is your single-use verification code to sign in to your ChatPulse account:</p>
                <div class="otp-box">
                    <div class="otp-number">{otp_code}</div>
                </div>
                <p class="notice">
                    This code is valid for <b>5 minutes</b>.<br>
                    If you did not request this code, you can safely ignore this email.
                </p>
                <div class="footer">
                    © {datetime.now().year} ChatPulse. All rights reserved.
                </div>
            </div>
        </body>
        </html>
        """

        msg.attach(MIMEText(html, 'html'))

        if cfg['use_ssl'] or cfg['port'] == 465:
            server = smtplib.SMTP_SSL(cfg['server'], cfg['port'], timeout=12)
        else:
            server = smtplib.SMTP(cfg['server'], cfg['port'], timeout=12)
            server.starttls()

        server.login(cfg['email'], cfg['password'])
        server.sendmail(cfg['email'], recipient_email, msg.as_string())
        server.quit()

        print(f"[EMAIL SUCCESS] Real OTP {otp_code} sent successfully to {recipient_email}")
        return True, None, None

    except smtplib.SMTPAuthenticationError as e:
        err = f"SMTP Authentication failed. For Gmail, use a 16-character 'App Password' (not normal password): {e}"
        print(f"[EMAIL ERROR] {err}")
        return False, err, otp_code
    except Exception as e:
        err = f"Failed to send email via SMTP ({cfg['server']}:{cfg['port']}): {e}"
        print(f"[EMAIL ERROR] {err}")
        return False, err, otp_code

def get_chat_id(u1, u2):
    return "_".join(sorted([u1, u2]))

# -------------------------------------------------------------
# REST API Endpoints
# -------------------------------------------------------------
@app.route('/')
def index():
    return render_template('index.html')

# SMTP Settings management
@app.route('/api/smtp/config', methods=['GET', 'POST'])
def api_smtp_config():
    if request.method == 'GET':
        cfg = get_smtp_config()
        # Mask password
        masked_pwd = '••••••••' if cfg['password'] else ''
        return jsonify({
            'server': cfg['server'],
            'port': cfg['port'],
            'email': cfg['email'],
            'has_password': bool(cfg['password']),
            'password_preview': masked_pwd,
            'use_ssl': cfg['use_ssl'],
            'is_configured': cfg['is_configured']
        })

    data = request.get_json() or {}
    server = data.get('server', '').strip()
    port = int(data.get('port', 587))
    email = data.get('email', '').strip()
    password = data.get('password', '').strip()
    use_ssl = bool(data.get('use_ssl', port == 465))

    if not server or not email or not password:
        return jsonify({'error': 'Server, email, and password are required'}), 400

    save_smtp_config(server, port, email, password, use_ssl)
    return jsonify({'success': True, 'message': 'SMTP configuration saved successfully!'})

@app.route('/api/smtp/test', methods=['POST'])
def api_smtp_test():
    data = request.get_json() or {}
    test_email = data.get('email', '').strip()
    if not test_email or '@' not in test_email:
        return jsonify({'error': 'Please provide a valid test email address'}), 400

    test_otp = str(random.randint(100000, 999999))
    success, error, _ = send_real_email_otp(test_email, test_otp)
    if success:
        return jsonify({'success': True, 'message': f'Test email sent successfully to {test_email}!'})
    return jsonify({'error': error or 'Failed to send test email'}), 500

# Send OTP
@app.route('/api/auth/send-otp', methods=['POST'])
def api_send_otp():
    data = request.get_json() or {}
    email = data.get('email', '').strip().lower()

    if not email or '@' not in email or '.' not in email:
        return jsonify({'error': 'Please enter a valid email address'}), 400

    otp = str(random.randint(100000, 999999))
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)

    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO otps (email, otp, expires_at)
            VALUES (?, ?, ?)
        ''', (email, otp, expires_at.strftime('%Y-%m-%d %H:%M:%S')))
        conn.commit()

    success, error, demo_code = send_real_email_otp(email, otp)

    if success:
        return jsonify({
            'success': True,
            'real_email': True,
            'message': f'A verification code was sent to {email}. Please check your inbox and spam folder.'
        })
    else:
        # If SMTP is not yet set up, return demo code so user is not blocked
        return jsonify({
            'success': True,
            'real_email': False,
            'demo_otp': demo_code,
            'notice': error,
            'message': 'Email delivery requires SMTP setup. Use the demo code displayed or configure SMTP in Email Settings.'
        })

# Verify OTP
@app.route('/api/auth/verify-otp', methods=['POST'])
def api_verify_otp():
    data = request.get_json() or {}
    email = data.get('email', '').strip().lower()
    otp = data.get('otp', '').strip()

    if not email or not otp:
        return jsonify({'error': 'Email and OTP are required'}), 400

    with get_db() as conn:
        row = conn.execute('SELECT * FROM otps WHERE email = ?', (email,)).fetchone()
        if not row:
            return jsonify({'error': 'No verification code was requested for this email'}), 400

        if row['otp'] != otp:
            return jsonify({'error': 'Invalid verification code'}), 400

        expires_at = datetime.strptime(row['expires_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires_at:
            return jsonify({'error': 'Verification code has expired. Please request a new one'}), 400

        # Delete verified OTP
        conn.execute('DELETE FROM otps WHERE email = ?', (email,))

        # Check existing user
        user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        is_new_user = False
        if not user:
            is_new_user = True
            user_id = str(uuid.uuid4())
            base_name = email.split('@')[0].capitalize()
            username = email.split('@')[0].lower().replace('.', '_')

            # Ensure unique username
            existing = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
            if existing:
                username = f"{username}_{random.randint(100, 999)}"

            conn.execute('''
                INSERT INTO users (id, email, username, name, avatar, about, is_private, status, is_online)
                VALUES (?, ?, ?, ?, 'avatar_1', 'Hey there! I am using ChatPulse', 0, 'online', 1)
            ''', (user_id, email, username, base_name))
            user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        else:
            conn.execute('UPDATE users SET is_online = 1 WHERE id = ?', (user['id'],))
        conn.commit()

    user_dict = dict(user)
    session['user_id'] = user_dict['id']
    return jsonify({
        'success': True,
        'user': user_dict,
        'is_new_user': is_new_user
    })

# Current logged-in user
@app.route('/api/auth/me')
def api_me():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'user': None})

    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        if not user:
            session.pop('user_id', None)
            return jsonify({'user': None})
        return jsonify({'user': dict(user)})

# Logout
@app.route('/api/auth/logout', methods=['POST'])
def api_logout():
    user_id = session.get('user_id')
    if user_id:
        with get_db() as conn:
            conn.execute('UPDATE users SET is_online = 0 WHERE id = ?', (user_id,))
            conn.commit()
    session.pop('user_id', None)
    return jsonify({'success': True})

# Update Profile (Name, About, Username, Avatar, Status, is_private)
@app.route('/api/profile/update', methods=['POST'])
def api_update_profile():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.get_json() or {}
    name = data.get('name')
    about = data.get('about')
    avatar = data.get('avatar')
    username = data.get('username')
    status = data.get('status')
    is_private = data.get('is_private')

    with get_db() as conn:
        cursor = conn.cursor()
        if username is not None:
            clean_username = username.strip().lower().replace('@', '').replace(' ', '_')
            # Check unique username
            existing = cursor.execute('SELECT id FROM users WHERE username = ? AND id != ?', (clean_username, user_id)).fetchone()
            if existing:
                return jsonify({'error': 'This username is already taken. Please choose another'}), 400
            cursor.execute('UPDATE users SET username = ? WHERE id = ?', (clean_username, user_id))

        if name:
            cursor.execute('UPDATE users SET name = ? WHERE id = ?', (name.strip(), user_id))
        if about is not None:
            cursor.execute('UPDATE users SET about = ? WHERE id = ?', (about.strip(), user_id))
        if avatar:
            cursor.execute('UPDATE users SET avatar = ? WHERE id = ?', (avatar, user_id))
        if status:
            cursor.execute('UPDATE users SET status = ? WHERE id = ?', (status, user_id))
        if is_private is not None:
            cursor.execute('UPDATE users SET is_private = ? WHERE id = ?', (1 if is_private else 0, user_id))

        conn.commit()
        user = cursor.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        user_dict = dict(user)

    socketio.emit('user_profile_updated', user_dict)
    return jsonify({'success': True, 'user': user_dict})

# Upload Profile Avatar directly from Gallery
@app.route('/api/profile/upload-avatar', methods=['POST'])
def api_upload_avatar():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    if 'file' not in request.files:
        return jsonify({'error': 'No image file uploaded'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in ['jpg', 'jpeg', 'png', 'webp', 'gif']:
        return jsonify({'error': 'Only JPG, PNG, WEBP, or GIF images are allowed'}), 400

    filename = f"avatar_{uuid.uuid4().hex[:12]}.{ext}"
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)

    try:
        # Resize avatar image cleanly
        img = Image.open(file.stream)
        img.thumbnail((500, 500))
        img.save(file_path)
    except Exception:
        file.seek(0)
        file.save(file_path)

    avatar_url = f"/static/uploads/{filename}"

    with get_db() as conn:
        conn.execute('UPDATE users SET avatar = ? WHERE id = ?', (avatar_url, user_id))
        conn.commit()
        user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        user_dict = dict(user)

    socketio.emit('user_profile_updated', user_dict)
    return jsonify({'success': True, 'avatar_url': avatar_url, 'user': user_dict})

# Generate Real QR Code for User Profile
@app.route('/api/profile/qrcode')
def api_get_qrcode():
    user_id = request.args.get('user_id') or session.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400

    with get_db() as conn:
        user = conn.execute('SELECT id, name, username, email FROM users WHERE id = ?', (user_id,)).fetchone()
        if not user:
            return jsonify({'error': 'User not found'}), 404

    host = request.host_url.rstrip('/')
    profile_url = f"{host}/#user={user['username'] or user['id']}"

    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=3,
    )
    qr.add_data(profile_url)
    qr.make(fit=True)

    img = qr.make_image(fill_color="#0f766e", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    # Return base64 or raw image
    if request.args.get('format') == 'base64':
        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return jsonify({'qr_code': f"data:image/png;base64,{b64}", 'profile_url': profile_url})

    return send_file(buf, mimetype='image/png')

# Delete Account Permanently
@app.route('/api/profile/delete', methods=['POST'])
def api_delete_account():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    with get_db() as conn:
        conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
        conn.execute('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', (user_id, user_id))
        conn.execute('DELETE FROM calls WHERE caller_id = ? OR receiver_id = ?', (user_id, user_id))
        conn.execute('DELETE FROM connect_requests WHERE sender_id = ? OR receiver_id = ?', (user_id, user_id))
        conn.commit()

    session.pop('user_id', None)
    return jsonify({'success': True})

# Upload General File / Photo in Chat
@app.route('/api/upload', methods=['POST'])
def api_upload():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else 'dat'
    filename = f"{uuid.uuid4().hex}.{ext}"
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(file_path)

    file_url = f"/static/uploads/{filename}"
    return jsonify({'success': True, 'url': file_url})

# Search Users by Name, Username, or Email (with Public/Private status)
@app.route('/api/users/search')
def api_search_users():
    user_id = session.get('user_id')
    query = request.args.get('q', '').strip().lower()

    with get_db() as conn:
        if query:
            users = conn.execute('''
                SELECT id, email, username, name, avatar, about, is_private, status, is_online
                FROM users
                WHERE id != ? AND (
                    LOWER(name) LIKE ? OR
                    LOWER(username) LIKE ? OR
                    LOWER(email) LIKE ?
                )
                LIMIT 40
            ''', (user_id or '', f'%{query}%', f'%{query}%', f'%{query}%')).fetchall()
        else:
            users = conn.execute('''
                SELECT id, email, username, name, avatar, about, is_private, status, is_online
                FROM users
                WHERE id != ?
                LIMIT 40
            ''', (user_id or '',)).fetchall()

        # Check follow/message connection status if current user is logged in
        result = []
        for u in users:
            u_dict = dict(u)
            if user_id:
                req = conn.execute('''
                    SELECT status FROM connect_requests
                    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                ''', (user_id, u['id'], u['id'], user_id)).fetchone()
                u_dict['connection_status'] = req['status'] if req else 'none'
            else:
                u_dict['connection_status'] = 'none'
            result.append(u_dict)

    return jsonify({'users': result})

# Connect / Message Request Endpoints (Instagram-style Private Accounts)
@app.route('/api/requests/send', methods=['POST'])
def api_send_connect_request():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.get_json() or {}
    target_id = data.get('target_id')
    if not target_id or target_id == user_id:
        return jsonify({'error': 'Invalid target'}), 400

    req_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO connect_requests (id, sender_id, receiver_id, status)
            VALUES (?, ?, ?, 'pending')
        ''', (req_id, user_id, target_id))
        conn.commit()

        sender = conn.execute('SELECT id, name, username, avatar FROM users WHERE id = ?', (user_id,)).fetchone()

    socketio.emit('new_connect_request', dict(sender), room=f"user_{target_id}")
    return jsonify({'success': True, 'message': 'Message request sent!'})

@app.route('/api/requests/respond', methods=['POST'])
def api_respond_connect_request():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.get_json() or {}
    sender_id = data.get('sender_id')
    action = data.get('action')  # 'accept' or 'decline'

    if not sender_id or action not in ['accept', 'decline']:
        return jsonify({'error': 'Invalid action'}), 400

    with get_db() as conn:
        if action == 'accept':
            conn.execute('''
                UPDATE connect_requests
                SET status = 'accepted'
                WHERE sender_id = ? AND receiver_id = ?
            ''', (sender_id, user_id))
        else:
            conn.execute('''
                DELETE FROM connect_requests
                WHERE sender_id = ? AND receiver_id = ?
            ''', (sender_id, user_id))
        conn.commit()

    socketio.emit('connect_request_updated', {'responder_id': user_id, 'action': action}, room=f"user_{sender_id}")
    return jsonify({'success': True, 'action': action})

@app.route('/api/requests/pending')
def api_get_pending_requests():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'requests': []})

    with get_db() as conn:
        rows = conn.execute('''
            SELECT cr.id, cr.sender_id, cr.created_at, u.name, u.username, u.avatar, u.about
            FROM connect_requests cr
            JOIN users u ON cr.sender_id = u.id
            WHERE cr.receiver_id = ? AND cr.status = 'pending'
            ORDER BY cr.created_at DESC
        ''', (user_id,)).fetchall()

    return jsonify({'requests': [dict(r) for r in rows]})

# Chats Overview
@app.route('/api/chats')
def api_get_chats():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'chats': []})

    with get_db() as conn:
        rows = conn.execute('''
            SELECT DISTINCT
                CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_id
            FROM messages
            WHERE (sender_id = ? OR receiver_id = ?) AND is_unsent = 0
        ''', (user_id, user_id, user_id)).fetchall()

        chats = []
        for r in rows:
            other_id = r['other_id']
            other_user = conn.execute('''
                SELECT id, email, username, name, avatar, about, is_private, status, is_online
                FROM users WHERE id = ?
            ''', (other_id,)).fetchone()

            if not other_user:
                continue

            last_msg = conn.execute('''
                SELECT text, msg_type, created_at, sender_id, is_read, is_edited, is_forwarded
                FROM messages
                WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
                  AND is_unsent = 0
                ORDER BY created_at DESC
                LIMIT 1
            ''', (user_id, other_id, other_id, user_id)).fetchone()

            unread_count = conn.execute('''
                SELECT COUNT(*) as count
                FROM messages
                WHERE sender_id = ? AND receiver_id = ? AND is_read = 0 AND is_unsent = 0
            ''', (other_id, user_id)).fetchone()['count']

            chats.append({
                'other_user': dict(other_user),
                'last_message': dict(last_msg) if last_msg else None,
                'unread_count': unread_count
            })

        chats.sort(
            key=lambda c: c['last_message']['created_at'] if c['last_message'] else '',
            reverse=True
        )

    return jsonify({'chats': chats})

# Get Messages with contact
@app.route('/api/chats/<other_id>/messages')
def api_get_messages(other_id):
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'messages': []})

    with get_db() as conn:
        # Mark as read
        conn.execute('''
            UPDATE messages
            SET is_read = 1
            WHERE sender_id = ? AND receiver_id = ? AND is_read = 0 AND is_unsent = 0
        ''', (other_id, user_id))
        conn.commit()

        msgs = conn.execute('''
            SELECT * FROM messages
            WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
              AND is_unsent = 0
            ORDER BY created_at ASC
        ''', (user_id, other_id, other_id, user_id)).fetchall()

    return jsonify({'messages': [dict(m) for m in msgs]})

# Clear chat
@app.route('/api/chats/<other_id>/clear', methods=['POST'])
def api_clear_chat(other_id):
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    with get_db() as conn:
        conn.execute('''
            DELETE FROM messages
            WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        ''', (user_id, other_id, other_id, user_id))
        conn.commit()

    return jsonify({'success': True})

# Call history
@app.route('/api/calls')
def api_get_calls():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'calls': []})

    with get_db() as conn:
        calls = conn.execute('''
            SELECT * FROM calls
            WHERE caller_id = ? OR receiver_id = ?
            ORDER BY created_at DESC
            LIMIT 60
        ''', (user_id, user_id)).fetchall()

    return jsonify({'calls': [dict(c) for c in calls]})

@app.route('/api/calls/clear', methods=['POST'])
def api_clear_calls():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401

    with get_db() as conn:
        conn.execute('DELETE FROM calls WHERE caller_id = ? OR receiver_id = ?', (user_id, user_id))
        conn.commit()

    return jsonify({'success': True})

# -------------------------------------------------------------
# Real-Time Socket.IO Handlers & Advanced Chat Features
# -------------------------------------------------------------
@socketio.on('connect')
def handle_connect():
    pass

@socketio.on('join')
def handle_join(data):
    user_id = data.get('user_id')
    if user_id:
        room_name = f"user_{user_id}"
        join_room(room_name)
        if user_id not in online_users:
            online_users[user_id] = set()
        online_users[user_id].add(request.sid)

        with get_db() as conn:
            conn.execute('UPDATE users SET is_online = 1 WHERE id = ?', (user_id,))
            conn.commit()

        emit('user_presence_change', {'user_id': user_id, 'is_online': True}, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    for uid, sids in list(online_users.items()):
        if request.sid in sids:
            sids.remove(request.sid)
            if not sids:
                del online_users[uid]
                with get_db() as conn:
                    conn.execute('UPDATE users SET is_online = 0 WHERE id = ?', (uid,))
                    conn.commit()
                emit('user_presence_change', {'user_id': uid, 'is_online': False}, broadcast=True)
            break

# Send Message
@socketio.on('send_message')
def handle_send_message(data):
    sender_id = data.get('sender_id')
    receiver_id = data.get('receiver_id')
    text = data.get('text', '')
    msg_type = data.get('type', 'text')
    media_url = data.get('media_url')
    duration = data.get('duration')
    is_forwarded = 1 if data.get('is_forwarded') else 0

    if not sender_id or not receiver_id:
        return

    msg_id = str(uuid.uuid4())
    chat_id = get_chat_id(sender_id, receiver_id)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    with get_db() as conn:
        conn.execute('''
            INSERT INTO messages (id, chat_id, sender_id, receiver_id, text, msg_type, media_url, duration, reactions, is_read, is_edited, is_unsent, is_forwarded, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, 0, 0, ?, ?)
        ''', (msg_id, chat_id, sender_id, receiver_id, text, msg_type, media_url, duration, is_forwarded, now))
        conn.commit()

        msg = conn.execute('SELECT * FROM messages WHERE id = ?', (msg_id,)).fetchone()
        msg_dict = dict(msg)

    emit('new_message', msg_dict, room=f"user_{sender_id}")
    emit('new_message', msg_dict, room=f"user_{receiver_id}")

# Unsend Message (Deletes message for everyone in real time)
@socketio.on('unsend_message')
def handle_unsend_message(data):
    msg_id = data.get('message_id')
    user_id = data.get('user_id')

    if not msg_id or not user_id:
        return

    with get_db() as conn:
        msg = conn.execute('SELECT sender_id, receiver_id FROM messages WHERE id = ?', (msg_id,)).fetchone()
        if not msg:
            return
        if msg['sender_id'] != user_id:
            return

        conn.execute('UPDATE messages SET is_unsent = 1 WHERE id = ?', (msg_id,))
        conn.commit()

        sender_id = msg['sender_id']
        receiver_id = msg['receiver_id']

    payload = {'message_id': msg_id}
    emit('message_unsent', payload, room=f"user_{sender_id}")
    emit('message_unsent', payload, room=f"user_{receiver_id}")

# Edit Message (Updates text with '(edited)' tag)
@socketio.on('edit_message')
def handle_edit_message(data):
    msg_id = data.get('message_id')
    user_id = data.get('user_id')
    new_text = data.get('new_text', '').strip()

    if not msg_id or not user_id or not new_text:
        return

    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    with get_db() as conn:
        msg = conn.execute('SELECT sender_id, receiver_id FROM messages WHERE id = ?', (msg_id,)).fetchone()
        if not msg:
            return
        if msg['sender_id'] != user_id:
            return

        conn.execute('''
            UPDATE messages
            SET text = ?, is_edited = 1, updated_at = ?
            WHERE id = ?
        ''', (new_text, now, msg_id))
        conn.commit()

        sender_id = msg['sender_id']
        receiver_id = msg['receiver_id']

    payload = {'message_id': msg_id, 'new_text': new_text, 'is_edited': 1}
    emit('message_edited', payload, room=f"user_{sender_id}")
    emit('message_edited', payload, room=f"user_{receiver_id}")

# Forward Message
@socketio.on('forward_message')
def handle_forward_message(data):
    sender_id = data.get('sender_id')
    target_ids = data.get('target_ids', [])
    text = data.get('text', '')
    msg_type = data.get('type', 'text')
    media_url = data.get('media_url')
    duration = data.get('duration')

    if not sender_id or not target_ids:
        return

    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    with get_db() as conn:
        for target_id in target_ids:
            msg_id = str(uuid.uuid4())
            chat_id = get_chat_id(sender_id, target_id)
            conn.execute('''
                INSERT INTO messages (id, chat_id, sender_id, receiver_id, text, msg_type, media_url, duration, reactions, is_read, is_edited, is_unsent, is_forwarded, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, 0, 0, 1, ?)
            ''', (msg_id, chat_id, sender_id, target_id, text, msg_type, media_url, duration, now))
            conn.commit()

            msg = conn.execute('SELECT * FROM messages WHERE id = ?', (msg_id,)).fetchone()
            msg_dict = dict(msg)

            emit('new_message', msg_dict, room=f"user_{sender_id}")
            emit('new_message', msg_dict, room=f"user_{target_id}")

@socketio.on('typing')
def handle_typing(data):
    receiver_id = data.get('receiver_id')
    sender_id = data.get('sender_id')
    is_typing = data.get('is_typing', False)
    if receiver_id:
        emit('user_typing', {'sender_id': sender_id, 'is_typing': is_typing}, room=f"user_{receiver_id}")

@socketio.on('message_reaction')
def handle_reaction(data):
    msg_id = data.get('message_id')
    user_id = data.get('user_id')
    emoji = data.get('emoji')

    if not msg_id or not user_id:
        return

    with get_db() as conn:
        msg = conn.execute('SELECT * FROM messages WHERE id = ?', (msg_id,)).fetchone()
        if not msg:
            return
        reactions = json.loads(msg['reactions'] or '{}')
        if reactions.get(user_id) == emoji:
            reactions.pop(user_id, None)
        else:
            reactions[user_id] = emoji

        conn.execute('UPDATE messages SET reactions = ? WHERE id = ?', (json.dumps(reactions), msg_id))
        conn.commit()

        receiver_id = msg['receiver_id']
        sender_id = msg['sender_id']

    payload = {'message_id': msg_id, 'reactions': reactions}
    emit('reaction_updated', payload, room=f"user_{sender_id}")
    emit('reaction_updated', payload, room=f"user_{receiver_id}")

@socketio.on('mark_read')
def handle_mark_read(data):
    other_id = data.get('other_id')
    user_id = data.get('user_id')

    if not other_id or not user_id:
        return

    with get_db() as conn:
        conn.execute('''
            UPDATE messages
            SET is_read = 1
            WHERE sender_id = ? AND receiver_id = ? AND is_read = 0 AND is_unsent = 0
        ''', (other_id, user_id))
        conn.commit()

    emit('messages_read_by_peer', {'peer_id': user_id}, room=f"user_{other_id}")

# -------------------------------------------------------------
# WebRTC Call Signaling Handlers
# -------------------------------------------------------------
@socketio.on('call_user')
def handle_call_user(data):
    caller_id = data.get('caller_id')
    receiver_id = data.get('receiver_id')
    call_type = data.get('call_type', 'audio')
    offer = data.get('offer')

    with get_db() as conn:
        caller = conn.execute('SELECT name, avatar, username FROM users WHERE id = ?', (caller_id,)).fetchone()

    emit('incoming_call', {
        'caller_id': caller_id,
        'caller_name': caller['name'] if caller else 'User',
        'caller_avatar': caller['avatar'] if caller else 'avatar_1',
        'caller_username': caller['username'] if caller else '',
        'call_type': call_type,
        'offer': offer
    }, room=f"user_{receiver_id}")

@socketio.on('answer_call')
def handle_answer_call(data):
    caller_id = data.get('caller_id')
    answer = data.get('answer')
    emit('call_answered', {'answer': answer}, room=f"user_{caller_id}")

@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    target_id = data.get('target_id')
    candidate = data.get('candidate')
    emit('ice_candidate', {'candidate': candidate}, room=f"user_{target_id}")

@socketio.on('end_call')
def handle_end_call(data):
    caller_id = data.get('caller_id')
    receiver_id = data.get('receiver_id')
    call_type = data.get('call_type', 'audio')
    duration = data.get('duration', 0)
    status = data.get('status', 'completed')

    call_id = str(uuid.uuid4())
    with get_db() as conn:
        caller = conn.execute('SELECT name, avatar FROM users WHERE id = ?', (caller_id,)).fetchone()
        receiver = conn.execute('SELECT name, avatar FROM users WHERE id = ?', (receiver_id,)).fetchone()
        if caller and receiver:
            conn.execute('''
                INSERT INTO calls (id, caller_id, caller_name, caller_avatar, receiver_id, receiver_name, receiver_avatar, call_type, status, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                call_id,
                caller_id, caller['name'], caller['avatar'],
                receiver_id, receiver['name'], receiver['avatar'],
                call_type, status, duration
            ))
            conn.commit()

    emit('call_ended', {'status': status, 'duration': duration}, room=f"user_{caller_id}")
    emit('call_ended', {'status': status, 'duration': duration}, room=f"user_{receiver_id}")

@socketio.on('reject_call')
def handle_reject_call(data):
    caller_id = data.get('caller_id')
    receiver_id = data.get('receiver_id')
    call_type = data.get('call_type', 'audio')

    call_id = str(uuid.uuid4())
    with get_db() as conn:
        caller = conn.execute('SELECT name, avatar FROM users WHERE id = ?', (caller_id,)).fetchone()
        receiver = conn.execute('SELECT name, avatar FROM users WHERE id = ?', (receiver_id,)).fetchone()
        if caller and receiver:
            conn.execute('''
                INSERT INTO calls (id, caller_id, caller_name, caller_avatar, receiver_id, receiver_name, receiver_avatar, call_type, status, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'declined', 0)
            ''', (
                call_id,
                caller_id, caller['name'], caller['avatar'],
                receiver_id, receiver['name'], receiver['avatar'],
                call_type
            ))
            conn.commit()

    emit('call_rejected', {}, room=f"user_{caller_id}")

@socketio.on('toggle_audio')
def handle_toggle_audio(data):
    target_id = data.get('target_id')
    is_muted = data.get('is_muted')
    emit('peer_audio_toggle', {'is_muted': is_muted}, room=f"user_{target_id}")

@socketio.on('toggle_video')
def handle_toggle_video(data):
    target_id = data.get('target_id')
    is_video_off = data.get('is_video_off')
    emit('peer_video_toggle', {'is_video_off': is_video_off}, room=f"user_{target_id}")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    print(f"\n==================================================")
    print(f"🚀 ChatPulse Server running at http://localhost:{port}")
    print(f"==================================================\n")
    socketio.run(app, host='0.0.0.0', port=port, debug=debug_mode, allow_unsafe_werkzeug=True)
