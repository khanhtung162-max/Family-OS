// ============================================================
// familyos-auth.js — ĐĂNG NHẬP GOOGLE + DRIVE DÙNG CHUNG CHO MỌI PHÒNG CỦA FAMILY OS
// ------------------------------------------------------------
// Nhúng 1 dòng vào trang nào cần:  <script src="familyos-auth.js"></script>
// Rồi dùng qua đối tượng toàn cục FOAuth:
//   FOAuth.isConfigured()              -> đã điền 3 giá trị cấu hình bên dưới chưa
//   FOAuth.getSession()                -> { email, name, picture, expiresAt } hoặc null
//   await FOAuth.signIn()              -> hiện hộp đăng nhập Google, trả về session
//   FOAuth.signOut()
//   await FOAuth.checkRole(nha)        -> { success, vaiTro, ten } — tra bảng email trong Sheet
//   await FOAuth.pickDriveFile(opts)   -> { id, name, mimeType, sizeBytes, url } hoặc null nếu huỷ
//   await FOAuth.downloadDriveFile(id) -> ArrayBuffer nội dung file
//
// PHÂN QUYỀN: Google chỉ lo xác minh "đây đúng là chủ email X". Ai được vào Nhà nào,
// vai trò gì -> vẫn tra bảng email trong Google Sheet qua Apps Script (action checkAuthEmail),
// giống hệt màn nhập email hiện tại. Thêm/bớt người = sửa Sheet, KHÔNG cần vào Google Cloud.
//
// QUYỀN DRIVE: chỉ xin "drive.file" — app CHỈ đọc được đúng file người dùng tự bấm chọn
// trong hộp chọn của Google, không đọc được phần còn lại của Drive.
// ============================================================
(function(){
  // ---------- CẤU HÌNH (điền 1 lần, lấy từ Google Cloud Console — xem hướng dẫn) ----------
  const CONFIG = {
    CLIENT_ID:      '22908122698-ad95f9fbbqprucp26ikl6ock8p91d0tm.apps.googleusercontent.com', // Google Auth Platform > Clients > Web client
    PICKER_API_KEY: 'AIzaSyAMoyZcAZDKTZQQXox6IRBoDVYzq12AsPM',                              // APIs & Services > Credentials > API key (giới hạn referrer + Picker API)
    APP_ID:         '22908122698',                       // Project number (dãy số) ở trang Dashboard của project
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbx9Ntbdp0l2x2g2zfo6UF2tuh6ls-lri26Yf7MoWhNpu3lJecxVHX-LHkNbrYY6jMnA/exec'
  };
  // Xin toàn bộ quyền cần dùng NGAY 1 LẦN -> người dùng chỉ đồng ý 1 lần, các phòng khác dùng lại.
  // Cả 4 quyền đều thuộc nhóm "không nhạy cảm" của Google -> không cần Google thẩm định app.
  const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file';
  const STORE_KEY = 'familyos_google_session'; // sessionStorage: sống theo tab, đóng tab là mất

  let session = null;      // { accessToken, expiresAt, email, name, picture }
  let tokenClient = null;

  // ---------- Nạp script ngoài khi cần (không làm chậm trang lúc mở) ----------
  const loaded = {};
  function loadScript(src){
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { delete loaded[src]; reject(new Error('Không tải được ' + src + ' (mạng chặn Google?)')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function isConfigured(){
    return !/^DIEN_/.test(CONFIG.CLIENT_ID) && !/^DIEN_/.test(CONFIG.PICKER_API_KEY) && !/^DIEN_/.test(CONFIG.APP_ID);
  }

  // ---------- Phiên đăng nhập ----------
  function restore(){
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && s.accessToken && s.expiresAt > Date.now() + 60000) session = s;
      else sessionStorage.removeItem(STORE_KEY);
    } catch(e){ /* trình duyệt chặn storage -> chỉ không nhớ phiên, vẫn chạy */ }
  }
  function persist(){
    try { session ? sessionStorage.setItem(STORE_KEY, JSON.stringify(session)) : sessionStorage.removeItem(STORE_KEY); } catch(e){}
  }

  function getSession(){
    if (session && session.expiresAt <= Date.now() + 60000){ session = null; persist(); }
    return session ? { email: session.email, name: session.name, picture: session.picture, expiresAt: session.expiresAt } : null;
  }

  async function signIn(){
    if (!isConfigured()) throw new Error('Chưa cấu hình Google Cloud (CLIENT_ID / API key / Project number trong familyos-auth.js).');
    await loadScript('https://accounts.google.com/gsi/client');

    const tokenResp = await new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: SCOPES,
        callback: resp => resp.error ? reject(new Error(resp.error_description || resp.error)) : resolve(resp),
        error_callback: err => reject(new Error(err.type === 'popup_closed' ? 'Bạn đã đóng hộp đăng nhập.' :
                                                err.type === 'popup_failed_to_open' ? 'Trình duyệt chặn cửa sổ bật lên — cho phép popup cho trang này rồi thử lại.' :
                                                (err.message || err.type)))
      });
      // Nếu đã từng đăng nhập trong tab này thì gợi ý đúng email cũ, đỡ phải chọn lại
      tokenClient.requestAccessToken({ prompt: '', login_hint: session ? session.email : undefined });
    });

    if (!google.accounts.oauth2.hasGrantedAllScopes(tokenResp, 'https://www.googleapis.com/auth/drive.file')){
      throw new Error('Bạn chưa tích ô cho phép "xem và quản lý file Drive mà bạn mở bằng ứng dụng này". Đăng nhập lại và tích ô đó.');
    }

    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenResp.access_token }
    }).then(r => r.json());

    session = {
      accessToken: tokenResp.access_token,
      expiresAt: Date.now() + (Number(tokenResp.expires_in) || 3600) * 1000,
      email: String(info.email || '').toLowerCase(),
      name: info.name || '',
      picture: info.picture || ''
    };
    persist();
    return getSession();
  }

  function signOut(){
    if (session && window.google && google.accounts && google.accounts.oauth2){
      try { google.accounts.oauth2.revoke(session.accessToken, () => {}); } catch(e){}
    }
    session = null; persist();
  }

  function requireToken(){
    const s = getSession();
    if (!s) throw new Error('Phiên đăng nhập Google đã hết hạn (1 giờ) — bấm Đăng nhập lại.');
    return session.accessToken;
  }

  // ---------- Phân quyền: tra bảng email trong Sheet (cùng action với màn nhập email hiện tại) ----------
  async function checkRole(nha){
    const s = getSession();
    if (!s) return { success: false, reason: 'chua-dang-nhap' };
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'checkAuthEmail', nha: nha, email: s.email })
    }).then(r => r.json());
    return res;
  }

  // ---------- Hộp chọn file Drive (Google Picker) ----------
  async function pickDriveFile(opts){
    opts = opts || {};
    const token = requireToken();
    await loadScript('https://apis.google.com/js/api.js');
    await new Promise((resolve, reject) => gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Không tải được Google Picker.')) }));

    const mimeTypes = (opts.mimeTypes || ['application/pdf']).join(',');
    const P = google.picker;

    const myDrive = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimeTypes).setIncludeFolders(true).setParent('root');
    myDrive.setLabel && myDrive.setLabel('Drive của tôi');
    const sharedWithMe = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimeTypes).setOwnedByMe(false);
    sharedWithMe.setLabel && sharedWithMe.setLabel('Được chia sẻ với tôi');
    const sharedDrives = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimeTypes).setIncludeFolders(true).setEnableDrives(true);
    const search = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimeTypes); // tab tìm theo tên file trên toàn Drive

    return new Promise(resolve => {
      const picker = new P.PickerBuilder()
        .setAppId(CONFIG.APP_ID)             // BẮT BUỘC với quyền drive.file — cấp quyền đọc đúng file được chọn
        .setDeveloperKey(CONFIG.PICKER_API_KEY)
        .setOAuthToken(token)
        .setLocale('vi')
        .setTitle(opts.title || 'Chọn tài liệu')
        .enableFeature(P.Feature.SUPPORT_DRIVES)
        .addView(search)
        .addView(myDrive)
        .addView(sharedWithMe)
        .addView(sharedDrives)
        .setCallback(data => {
          if (data.action === P.Action.PICKED){
            const d = data.docs[0];
            resolve({ id: d.id, name: d.name, mimeType: d.mimeType, sizeBytes: Number(d.sizeBytes) || 0, url: d.url });
          } else if (data.action === P.Action.CANCEL){
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function downloadDriveFile(fileId){
    const token = requireToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok){
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch(e){}
      if (res.status === 401) msg = 'Phiên Google hết hạn — đăng nhập lại. (' + msg + ')';
      if (res.status === 403 || res.status === 404) msg = 'Tài khoản này không có quyền đọc file (file chưa được chia sẻ cho email đang đăng nhập?). (' + msg + ')';
      throw new Error(msg);
    }
    return res.arrayBuffer();
  }

  restore();
  window.FOAuth = { isConfigured, getSession, signIn, signOut, checkRole, pickDriveFile, downloadDriveFile, loadScript };
})();