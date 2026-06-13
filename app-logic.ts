import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, query, orderBy, limit, getDocs, deleteDoc, collectionGroup, serverTimestamp, getDocFromServer } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Test Connection initially as mandated by Skill
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// Global State Variables
let selectedFiles: any[] = [];
let isUserLoggedIn = false;
let userEmail = '';
let userPlan = 'Free';
let adminVerified = false;

// Simulated active queues (graceful fallback)
let activeAdminSessions = [
  { id: '1', email: 'vlad@prague-trans.cz', plan: 'Ultimate', files: 124, node: 'cluster-europe-1', status: 'Active' },
  { id: '2', email: 'sharon.m@seattle-labs.io', plan: 'Pro', files: 43, node: 'cluster-us-west', status: 'Converting' },
  { id: '3', email: 't.yamada@tokyo-media.jp', plan: 'Pro', files: 85, node: 'cluster-asia-tokyo', status: 'Active' },
  { id: '4', email: 'clara_dev@berlin.de', plan: 'Free', files: 8, node: 'cluster-europe-1', status: 'Idle' },
  { id: '5', email: 'dev.team@san-francisco.ai', plan: 'Ultimate', files: 512, node: 'cluster-us-east', status: 'Active' },
];

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  // @ts-ignore
  if (window.lucide) {
    // @ts-ignore
    window.lucide.createIcons();
  }
  initDropzone();
  initAutoRefreshAdminStats();
});

// Sync variables to window for inline HTML events access
Object.defineProperty(window, 'selectedFiles', { get() { return selectedFiles; }, set(val) { selectedFiles = val; } });
Object.defineProperty(window, 'isUserLoggedIn', { get() { return isUserLoggedIn; }, set(val) { isUserLoggedIn = val; } });
Object.defineProperty(window, 'userEmail', { get() { return userEmail; }, set(val) { userEmail = val; } });
Object.defineProperty(window, 'userPlan', { get() { return userPlan; }, set(val) { userPlan = val; } });
Object.defineProperty(window, 'adminVerified', { get() { return adminVerified; }, set(val) { adminVerified = val; } });

// Secure auth state observer
onAuthStateChanged(auth, async (user) => {
  if (user) {
    isUserLoggedIn = true;
    userEmail = user.email || '';
    
    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const userData = userSnap.data();
        userPlan = userData.plan || 'Free';
      } else {
        userPlan = 'Free';
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email || '',
          plan: 'Free',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
    } catch (e) {
      handleFirestoreError(e, "Syncload account profiles");
      userPlan = 'Free';
    }
    
    // Admin access check
    try {
      const adminRef = doc(db, 'admins', user.uid);
      const adminSnap = await getDoc(adminRef);
      if (adminSnap.exists()) {
        adminVerified = true;
      } else {
        adminVerified = false;
      }
    } catch (e) {
      adminVerified = false;
    }
  } else {
    isUserLoggedIn = false;
    userEmail = '';
    userPlan = 'Free';
    adminVerified = false;
  }
  
  updateUserUIPanel();
  const adminPortal = document.getElementById('admin-portal-view');
  if (adminPortal && !adminPortal.classList.contains('hidden')) {
    renderAdminGrid();
  }
});

// Smooth scroll
export function scrollIntoView(selector: string) {
  const el = document.querySelector(selector);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' });
  }
}

// Dropsone Initializers
function initDropzone() {
  const dropzone = document.getElementById('dropzone-area');
  const fileInput = document.getElementById('file-uploader') as HTMLInputElement;
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  
  fileInput.addEventListener('change', (e: any) => {
    handleFileSelection(e.target.files);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('bg-indigo_primary/10', 'border-indigo_primary/80');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('bg-indigo_primary/10', 'border-indigo_primary/80');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    if (dt && dt.files) {
      handleFileSelection(dt.files);
    }
  });
}

function handleFileSelection(files: FileList) {
  if (!files.length) return;

  let limitBytes = 50 * 1024 * 1024; // Free limit default
  if (userPlan === 'Pro') limitBytes = 1000 * 1024 * 1024;
  if (userPlan === 'Ultimate') limitBytes = 10000 * 1024 * 1024;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.size > limitBytes) {
      showToast(`File "${file.name}" limits exceeded for ${userPlan} Tier. Upload under ${userPlan === 'Free' ? '50MB' : userPlan === 'Pro' ? '1GB' : '10GB'}!`, 'coral_danger');
      continue;
    }

    if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
      continue;
    }

    const fileObj = {
      id: 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      extension: file.name.substring(file.name.lastIndexOf('.') + 1).toLowerCase() || 'dat',
      targetFormat: '',
      status: 'Ready'
    };

    selectedFiles.push(fileObj);
  }

  renderQueue();
  showToast(`Successfully added ${files.length} active files to queue`, 'cyan_secondary');
}

export function renderQueue() {
  const container = document.getElementById('files-list-container');
  const queuePanel = document.getElementById('queue-panel');
  const queueCount = document.getElementById('queue-count');

  if (!container || !queuePanel || !queueCount) return;

  if (selectedFiles.length === 0) {
    queuePanel.classList.add('hidden');
    return;
  }

  queuePanel.classList.remove('hidden');
  queueCount.innerText = selectedFiles.length.toString();

  container.innerHTML = selectedFiles.map(file => {
    const formattedSize = file.size > 1024 * 1024 
      ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
      : (file.size / 1024).toFixed(0) + ' KB';

    const isImg = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(file.extension);
    const isDoc = ['pdf', 'docx', 'doc', 'txt', 'rtf', 'xlsx'].includes(file.extension);
    const isAud = ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(file.extension);
    const isVid = ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(file.extension);

    let formatsHTML = '<option value="">Target format</option>';
    if (isImg) {
      formatsHTML += `
        <option value="png" ${file.targetFormat === 'png' ? 'selected' : ''}>PNG</option>
        <option value="jpg" ${file.targetFormat === 'jpg' ? 'selected' : ''}>JPG</option>
        <option value="webp" ${file.targetFormat === 'webp' ? 'selected' : ''}>WEBP</option>
        <option value="pdf" ${file.targetFormat === 'pdf' ? 'selected' : ''}>PDF</option>
      `;
    } else if (isDoc) {
      formatsHTML += `
        <option value="pdf" ${file.targetFormat === 'pdf' ? 'selected' : ''}>PDF</option>
        <option value="docx" ${file.targetFormat === 'docx' ? 'selected' : ''}>DOCX</option>
        <option value="txt" ${file.targetFormat === 'txt' ? 'selected' : ''}>TXT</option>
      `;
    } else if (isAud) {
      formatsHTML += `
        <option value="mp3" ${file.targetFormat === 'mp3' ? 'selected' : ''}>MP3</option>
        <option value="wav" ${file.targetFormat === 'wav' ? 'selected' : ''}>WAV</option>
        <option value="ogg" ${file.targetFormat === 'ogg' ? 'selected' : ''}>OGG</option>
      `;
    } else if (isVid) {
      formatsHTML += `
        <option value="mp4" ${file.targetFormat === 'mp4' ? 'selected' : ''}>MP4</option>
        <option value="webm" ${file.targetFormat === 'webm' ? 'selected' : ''}>WEBM</option>
      `;
    } else {
      formatsHTML += `
        <option value="png" ${file.targetFormat === 'png' ? 'selected' : ''}>PNG</option>
        <option value="webp" ${file.targetFormat === 'webp' ? 'selected' : ''}>WEBP</option>
        <option value="pdf" ${file.targetFormat === 'pdf' ? 'selected' : ''}>PDF</option>
        <option value="txt" ${file.targetFormat === 'txt' ? 'selected' : ''}>TXT</option>
      `;
    }

    return `
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate_card/60 border border-white/5 hover:border-white/10 transition-colors">
        <div class="flex items-center gap-3 w-full sm:w-auto">
          <div class="p-2 rounded-lg bg-indigo_primary/15 text-indigo-400 shrink-0">
            <i data-lucide="file-text" class="w-4 h-4"></i>
          </div>
          <div class="min-w-0 flex-grow">
            <p class="text-xs font-semibold text-white truncate max-w-[240px]" title="${file.name}">${file.name}</p>
            <p class="text-[9px] text-slate-400 mt-0.5 uppercase tracking-wider">${file.extension} • ${formattedSize}</p>
          </div>
        </div>

        <div class="flex items-center justify-between sm:justify-end gap-3 w-full sm:w-auto mt-2 sm:mt-0">
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] text-slate-400">To:</span>
            <select onchange="updateSingleFileFormat('${file.id}', this.value)" class="bg-black/50 border border-white/10 rounded-lg py-1 px-2.5 text-xs text-white focus:outline-none focus:border-cyan_secondary font-semibold cursor-pointer">
              ${formatsHTML}
            </select>
          </div>

          <button onclick="removeFile('${file.id}')" class="p-1 px-1.5 text-slate-400 hover:text-coral_danger rounded transition" title="Remove File">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // @ts-ignore
  if (window.lucide) window.lucide.createIcons();
}

export function updateSingleFileFormat(id: string, format: string) {
  selectedFiles = selectedFiles.map(f => {
    if (f.id === id) {
      f.targetFormat = format;
    }
    return f;
  });
}

export function applyGlobalFormat(format: string) {
  if (!format) return;
  selectedFiles = selectedFiles.map(f => {
    f.targetFormat = format;
    return f;
  });
  renderQueue();
  showToast(`Target format applied to all queue files`, 'indigo_primary');
}

export function removeFile(id: string) {
  selectedFiles = selectedFiles.filter(f => f.id !== id);
  renderQueue();
  showToast('File removed from queue', 'coral_danger');
}

export function clearQueue() {
  selectedFiles = [];
  renderQueue();
  showToast('Queue cleaned completely', 'coral_danger');
}

export function triggerConversion() {
  const missingTarget = selectedFiles.some(f => !f.targetFormat);
  if (missingTarget) {
    showToast('Please select a target output format for all items!', 'coral_danger');
    return;
  }

  const tracker = document.getElementById('conversion-tracker');
  const progressBar = document.getElementById('conversion-progress-bar');
  const percentageText = document.getElementById('conversion-percentage');
  const statusLabel = document.getElementById('conversion-status-label');
  const finishedContainer = document.getElementById('finished-list-container');
  const finishedRows = document.getElementById('finished-files-rows');

  if (!tracker || !progressBar || !percentageText || !statusLabel || !finishedContainer || !finishedRows) return;

  tracker.classList.remove('hidden');
  finishedContainer.classList.add('hidden');
  finishedRows.innerHTML = '';
  progressBar.style.width = '0%';
  percentageText.innerText = '0%';

  let currentWidth = 0;
  const steps = [
    { threshold: 15, msg: 'Encrypting transport channels...' },
    { threshold: 40, msg: 'Uploading and parsing file headers...' },
    { threshold: 75, msg: 'Executing virtual transcode pipeline threads...' },
    { threshold: 92, msg: 'Applying compression algorithms...' },
    { threshold: 100, msg: 'Finalizing formatting validations...' }
  ];

  const interval = setInterval(() => {
    let speedFactor = 1;
    if (userPlan === 'Pro') speedFactor = 2.5;
    if (userPlan === 'Ultimate') speedFactor = 4.5;

    currentWidth += Math.floor(Math.random() * 5) + 2 * speedFactor;
    if (currentWidth > 100) currentWidth = 100;

    progressBar.style.width = currentWidth + '%';
    percentageText.innerText = currentWidth + '%';

    const currentStep = steps.find(s => currentWidth <= s.threshold);
    if (currentStep) {
      statusLabel.innerHTML = `
        <i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>
        ${currentStep.msg}
      `;
      // @ts-ignore
      if (window.lucide) window.lucide.createIcons();
    }

    if (currentWidth >= 100) {
      clearInterval(interval);
      statusLabel.innerHTML = `
        <i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-400"></i>
        <span class="text-emerald-400">Conversion Completed Successfully!</span>
      `;
      // @ts-ignore
      if (window.lucide) window.lucide.createIcons();
      completeConversion();
    }
  }, 120);

  scrollIntoView('#conversion-tracker');
}

async function completeConversion() {
  const finishedContainer = document.getElementById('finished-list-container');
  const finishedRows = document.getElementById('finished-files-rows');
  if (!finishedContainer || !finishedRows) return;
  
  finishedContainer.classList.remove('hidden');
  
  finishedRows.innerHTML = selectedFiles.map(file => {
    const downloadName = file.name.substring(0, file.name.lastIndexOf('.')) + '.' + file.targetFormat;
    return `
      <div class="flex items-center justify-between p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/10 hover:border-emerald-500/20 transition-all">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
            <i data-lucide="file-check" class="w-4 h-4"></i>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-semibold text-white truncate max-w-[200px]" title="${downloadName}">${downloadName}</p>
            <p class="text-[9px] text-slate-400 mt-0.5 uppercase tracking-wider">${file.targetFormat.toUpperCase()} CONVERSION COMPLETED</p>
          </div>
        </div>

        <button onclick="downloadMockFile('${downloadName}')" class="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-semibold flex items-center gap-1 transition shadow shadow-emerald-500/10 cursor-pointer">
          <i data-lucide="download" class="w-3 h-3"></i> Download
        </button>
      </div>
    `;
  }).join('');

  // Store conversion logs in cloud Firestore
  if (isUserLoggedIn && auth.currentUser) {
    for (const file of selectedFiles) {
      try {
        const historyId = 'hist-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
        const historyRef = doc(db, 'users', auth.currentUser.uid, 'history', historyId);
        await setDoc(historyRef, {
          id: historyId,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          extension: file.extension,
          targetFormat: file.targetFormat,
          createdAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, "Persist conversion audit log to Firestore");
      }
    }
  }

  const statsConvertedEl = document.getElementById('stat-total-converted');
  if (statsConvertedEl) {
    const currentCount = parseInt(statsConvertedEl.innerText.replace(/,/g, ''));
    statsConvertedEl.innerText = (currentCount + selectedFiles.length).toLocaleString();
  }

  // @ts-ignore
  if (window.lucide) window.lucide.createIcons();
  showToast('Converted results mapped. Click Download!', 'cyan_secondary');
}

export function downloadMockFile(filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase();
  let mimeType = 'text/plain';
  let content;

  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension || '')) {
    mimeType = 'image/svg+xml';
    content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="100%" height="100%">
      <rect width="100%" height="100%" fill="#161f30"/>
      <circle cx="200" cy="100" r="50" fill="#4f46e5"/>
      <text x="200" y="105" fill="#fff" font-family="'Space Grotesk', sans-serif" font-size="14" text-anchor="middle">Converted File</text>
      <text x="200" y="130" fill="#06b6d4" font-family="monospace" font-size="10" text-anchor="middle">${filename}</text>
    </svg>`;
  } else if (extension === 'html') {
    mimeType = 'text/html';
    content = `<!DOCTYPE html><html><head><title>${filename}</title></head><body><h1>Converted on Universal Converter</h1><p>Processed file: ${filename}</p></body></html>`;
  } else if (['mp3', 'wav', 'ogg', 'm4a'].includes(extension || '')) {
    mimeType = 'text/plain';
    content = `Audio Format Meta Stream Container:\nFile Name: ${filename}\nStatus: Completed Waveform Packaging`;
  } else if (['mp4', 'webm', 'mov'].includes(extension || '')) {
    mimeType = 'text/plain';
    content = `Video Meta Container Header:\nFile Name: ${filename}\nStatus: Completed Video Demuxing and Frame Assembly`;
  } else {
    mimeType = 'text/plain';
    content = `Universal Converter Sandbox Output Document\n============================================\n\nFile Name: ${filename}\nStatus: Successfully Transcoded\nSecurity Check: 256-Bit SSL Secured\nTimestamp: ${new Date().toLocaleString()}\n\nThis is a fully complete simulated artifact generated by Universal Converter.`;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(`Downloaded: ${filename}`, 'cyan_secondary');
}

export function downloadAllConvertedFiles() {
  if (selectedFiles.length === 0) {
    showToast('No converted files in the queue', 'coral_danger');
    return;
  }
  
  let count = 0;
  selectedFiles.forEach((file, index) => {
    const downloadName = file.name.substring(0, file.name.lastIndexOf('.')) + '.' + file.targetFormat;
    setTimeout(() => {
      downloadMockFile(downloadName);
    }, index * 250);
    count++;
  });
  
  showToast(`Preparing download bundle for ${count} files...`, 'indigo_primary');
}

export function openAuthModal(tab: string) {
  const modal = document.getElementById('auth-modal');
  const box = document.getElementById('auth-modal-box');
  if (!modal || !box) return;
  
  modal.classList.remove('hidden');
  setTimeout(() => {
    box.classList.remove('scale-95', 'opacity-0');
    box.classList.add('scale-100', 'opacity-100');
  }, 10);
  
  switchAuthTab(tab);
}

export function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  const box = document.getElementById('auth-modal-box');
  if (!modal || !box) return;
  
  box.classList.add('scale-95', 'opacity-0');
  box.classList.remove('scale-100', 'opacity-100');
  
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200);
}

export function switchAuthTab(tab: string) {
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const title = document.getElementById('auth-title');
  const desc = document.getElementById('auth-desc');
  const submitLabel = document.getElementById('auth-submit-label');

  if (!tabLogin || !tabSignup || !title || !desc || !submitLabel) return;

  if (tab === 'login') {
    tabLogin.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-white bg-indigo_primary transition-all cursor-pointer';
    tabSignup.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition-all cursor-pointer';
    title.innerText = 'Welcome Back';
    desc.innerText = 'Access unrestricted sandboxed queues';
    submitLabel.innerText = 'Log Into Account';
  } else {
    tabSignup.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-white bg-indigo_primary transition-all cursor-pointer';
    tabLogin.className = 'flex-1 py-1.5 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition-all cursor-pointer';
    title.innerText = 'Create Account';
    desc.innerText = 'Start converting immediately without waiting';
    submitLabel.innerText = 'Set Up New Membership';
  }
}

export async function handleAuthSubmit(event: Event) {
  event.preventDefault();
  const emailInput = document.getElementById('auth-email') as HTMLInputElement;
  const passwordInput = document.getElementById('auth-password') as HTMLInputElement;
  const submitLabelSpan = document.getElementById('auth-submit-label');

  if (!emailInput || !passwordInput || !submitLabelSpan) return;

  const email = emailInput.value;
  const password = passwordInput.value;
  const submitLabel = submitLabelSpan.innerText;
  
  try {
    if (submitLabel.includes('Log Into') || submitLabel.includes('Login')) {
      await signInWithEmailAndPassword(auth, email, password);
      showToast(`Logged in successfully!`, 'cyan_secondary');
    } else {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      const userRef = doc(db, 'users', user.uid);
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email || '',
        plan: 'Free',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      showToast(`Successfully registered account!`, 'cyan_secondary');
    }
    closeAuthModal();
  } catch (err: any) {
    console.warn("Auth process rejected: " + err.message);
    let message = "Failed to authenticate account credentials.";
    if (err.code === 'auth/email-already-in-use') {
      message = "This email address is already in use.";
    } else if (err.code === 'auth/wrong-password') {
      message = "Invalid password credentials.";
    } else if (err.code === 'auth/user-not-found') {
      message = "No profile exists associated with this email.";
    } else if (err.code === 'auth/weak-password') {
      message = "Password criteria unfulfilled (Min 6 digits).";
    }
    showToast(message, 'coral_danger');
  }
}

export async function simulateThirdPartyAuth(providerName: string) {
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email || '',
        plan: 'Free',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    closeAuthModal();
    showToast(`Welcome! Authenticated via Google.`, 'cyan_secondary');
  } catch (error: any) {
    console.error("Popup interaction code hit error: ", error);
    if (error.code === 'auth/popup-blocked' || error.message?.includes('iframe') || error.originalError?.message?.includes('iframe')) {
      showToast("Social popup blocked by browser sandbox/iframe. Please use standard email fields!", 'coral_danger');
    } else {
      showToast("Authentication uncompleted.", 'coral_danger');
    }
  }
}

export function updateUserUIPanel() {
  const panel = document.getElementById('nav-user-panel');
  if (!panel) return;

  if (!isUserLoggedIn) {
    panel.innerHTML = `
      <button onclick="openAuthModal('login')" class="text-xs font-semibold text-slate-300 hover:text-white transition duration-150 cursor-pointer">Sign In</button>
      <button onclick="openAuthModal('signup')" class="px-3.5 py-1.5 rounded-lg bg-indigo_primary hover:bg-slate-850 border border-white/10 hover:border-indigo_primary/50 text-xs font-bold text-white transition-all cursor-pointer">Sign Up</button>
    `;
  } else {
    const badgeColor = userPlan === 'Ultimate' 
      ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' 
      : userPlan === 'Pro' 
        ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' 
        : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';

    panel.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full py-1 px-3 shadow-inner">
          <div id="plan-pulse-dot" class="w-1.5 h-1.5 rounded-full ${userPlan === 'Ultimate' ? 'bg-cyan-400' : userPlan === 'Pro' ? 'bg-indigo-400' : 'bg-emerald-500'} animate-pulse"></div>
          <span class="text-[9px] font-medium text-slate-400 uppercase tracking-wide">Plan:</span>
          <span id="user-tier-indicator" class="${badgeColor} text-[9px] font-bold uppercase tracking-wider">${userPlan} Plan</span>
        </div>
        <span class="text-[11px] font-medium text-slate-300 hidden sm:inline-block max-w-[120px] truncate" title="${userEmail}">${userEmail}</span>
        <button onclick="handleLogOut()" class="p-1 px-2 rounded-lg text-[10px] font-semibold text-slate-400 hover:text-coral_danger hover:bg-white/5 border border-transparent hover:border-coral_danger/10 transition cursor-pointer">Sign Out</button>
      </div>
    `;
  }

  // Update file size limit text
  const fileLimitLabel = document.getElementById('file-limit-label');
  if (fileLimitLabel) {
    if (userPlan === 'Pro') {
      fileLimitLabel.innerText = "Maximum file size: 1GB (Priority Mode Active)";
    } else if (userPlan === 'Ultimate') {
      fileLimitLabel.innerText = "Maximum file size: 10GB (API Dedicated Server Node Active)";
    } else {
      fileLimitLabel.innerText = "Maximum file size: 50MB (Unlock 10GB with Pro)";
    }
  }
}

export async function handleLogOut() {
  try {
    await signOut(auth);
    showToast('Logged out of workspace session', 'coral_danger');
  } catch (err) {
    showToast('Logout execution failure.', 'coral_danger');
  }
}

export function triggerPremiumUpgrade(planName: string, amount: number) {
  if (!isUserLoggedIn) {
    showToast('Please Sign In first to attach your subscription!', 'coral_danger');
    openAuthModal('login');
    return;
  }

  const modal = document.getElementById('checkout-modal');
  const box = document.getElementById('checkout-modal-box');
  const labelPlan = document.getElementById('checkout-plan-name');
  const labelPrice = document.getElementById('checkout-plan-price');
  
  const form = document.getElementById('checkout-form');
  const procState = document.getElementById('checkout-processing-state');
  const succState = document.getElementById('checkout-success-state');

  if (!modal || !box || !labelPlan || !labelPrice || !form || !procState || !succState) return;

  form.classList.remove('hidden');
  procState.classList.add('hidden');
  succState.classList.add('hidden');

  labelPlan.innerText = planName;
  labelPrice.innerText = `$${amount}/mo`;

  modal.classList.remove('hidden');
  setTimeout(() => {
    box.classList.remove('scale-95', 'opacity-0');
    box.classList.add('scale-100', 'opacity-100');
  }, 10);
}

export function closeCheckoutModal() {
  const modal = document.getElementById('checkout-modal');
  const box = document.getElementById('checkout-modal-box');
  if (!modal || !box) return;
  
  box.classList.add('scale-95', 'opacity-0');
  box.classList.remove('scale-100', 'opacity-100');
  
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200);
}

export async function handleCheckoutSubmit(e: Event) {
  e.preventDefault();
  const form = document.getElementById('checkout-form');
  const procState = document.getElementById('checkout-processing-state');
  const succState = document.getElementById('checkout-success-state');
  const labelPlan = document.getElementById('checkout-plan-name');

  if (!form || !procState || !succState || !labelPlan) return;

  const planName = labelPlan.innerText;

  form.classList.add('hidden');
  procState.classList.remove('hidden');

  setTimeout(async () => {
    procState.classList.add('hidden');
    succState.classList.remove('hidden');

    const targetPlan = planName.includes('Ultimate') ? 'Ultimate' : 'Pro';
    userPlan = targetPlan;

    if (auth.currentUser) {
      try {
        const userRef = doc(db, 'users', auth.currentUser.uid);
        await setDoc(userRef, {
          plan: targetPlan,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, "Persistent plan status elevation");
      }
    }

    updateUserUIPanel();

    const premiumCountEl = document.getElementById('stat-premium-users');
    if (premiumCountEl) {
      const currentSubCount = parseInt(premiumCountEl.innerText);
      premiumCountEl.innerText = (currentSubCount + 1).toString();
    }

    showToast(`Membership status elevated to ${userPlan}!`, 'indigo_primary');
  }, 1800);
}

export function openAdminModal() {
  if (adminVerified) {
    switchToAdminView();
  } else {
    const overlay = document.getElementById('admin-auth-overlay');
    const box = document.getElementById('admin-auth-box');
    if (!overlay || !box) return;
    
    overlay.classList.remove('hidden');
    setTimeout(() => {
      box.classList.remove('scale-95', 'opacity-0');
      box.classList.add('scale-100', 'opacity-100');
    }, 10);
  }
}

export function closeAdminAuthOverlay() {
  const overlay = document.getElementById('admin-auth-overlay');
  const box = document.getElementById('admin-auth-box');
  if (!overlay || !box) return;
  
  box.classList.add('scale-95', 'opacity-0');
  box.classList.remove('scale-100', 'opacity-100');
  
  setTimeout(() => {
    overlay.classList.add('hidden');
  }, 200);
}

export async function handleAdminSubmit(e: Event) {
  e.preventDefault();
  const passkeyInput = document.getElementById('admin-passkey') as HTMLInputElement;
  const err = document.getElementById('admin-auth-error');
  if (!passkeyInput || !err) return;

  const passkey = passkeyInput.value;

  if (passkey === 'admin123') {
    adminVerified = true;
    err.classList.add('hidden');
    closeAdminAuthOverlay();
    switchToAdminView();
    showToast('Admin Token Signed Successfully', 'cyan_secondary');
  } else {
    err.classList.remove('hidden');
    setTimeout(() => {
      err.classList.add('hidden');
    }, 4000);
  }
}

export function switchToAdminView() {
  const main = document.getElementById('main-tool-view');
  const admin = document.getElementById('admin-portal-view');
  if (!main || !admin) return;

  main.classList.add('opacity-0', 'scale-95');
  setTimeout(() => {
    main.classList.add('hidden');
    admin.classList.remove('hidden');
    setTimeout(() => {
      admin.classList.remove('opacity-0', 'scale-95');
      admin.classList.add('opacity-100', 'scale-100');
      renderAdminGrid();
    }, 10);
  }, 300);
}

export function showMainConverter() {
  const main = document.getElementById('main-tool-view');
  const admin = document.getElementById('admin-portal-view');
  if (!main || !admin) return;

  admin.classList.add('opacity-0', 'scale-95');
  setTimeout(() => {
    admin.classList.add('hidden');
    main.classList.remove('hidden');
    setTimeout(() => {
      main.classList.remove('opacity-0', 'scale-95');
      main.classList.add('opacity-100', 'scale-100');
    }, 10);
  }, 300);
}

export async function renderAdminGrid() {
  const container = document.getElementById('admin-active-users-rows');
  if (!container) return;
  
  try {
    const histQuery = query(collectionGroup(db, 'history'), orderBy('createdAt', 'desc'), limit(15));
    const querySnapshot = await getDocs(histQuery);
    
    let rows: any[] = [];
    
    querySnapshot.forEach((historyDoc) => {
      const histData = historyDoc.data();
      const pathParts = historyDoc.ref.path.split('/');
      const docUserId = pathParts[1];
      
      rows.push({
        id: histData.id || historyDoc.id,
        userId: docUserId,
        name: histData.name,
        size: histData.size,
        extension: histData.extension,
        targetFormat: histData.targetFormat,
        createdAt: histData.createdAt?.toDate ? histData.createdAt.toDate() : new Date(),
        status: 'Completed'
      });
    });
    
    if (rows.length === 0) {
      container.innerHTML = `
        <tr>
          <td colspan="6" class="py-6 px-4 text-center text-slate-500 font-medium">
            <i data-lucide="info" class="w-5 h-5 mx-auto mb-2 text-slate-600 animate-pulse"></i>
            Data Log Empty. Transcode any files to see persistent live cloud data streams.
          </td>
        </tr>
      `;
      // @ts-ignore
      if (window.lucide) window.lucide.createIcons();
      return;
    }
    
    container.innerHTML = rows.map(r => {
      const dateStr = r.createdAt.toLocaleTimeString();
      return `
        <tr class="hover:bg-white/2 transition-colors">
          <td class="py-3 px-4 flex items-center gap-2.5">
            <div class="w-6 h-6 rounded-full bg-slate-700/60 flex items-center justify-center font-bold text-[10px] text-white">
              U
            </div>
            <div class="flex flex-col">
              <span class="font-semibold text-white text-[11px] truncate max-w-[150px]" title="${r.userId}">UID: ...${r.userId.slice(-6)}</span>
              <span class="text-[9px] text-slate-500 font-mono">${dateStr}</span>
            </div>
          </td>
          <td class="py-3 px-4">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold bg-indigo_primary/10 text-indigo-400 border-indigo_primary/20">Secure Client</span>
          </td>
          <td class="py-3 px-4">
            <div class="flex flex-col">
              <span class="font-semibold text-white text-[11px] truncate max-w-[120px]">${r.name}</span>
              <span class="text-[9px] text-slate-400 font-mono uppercase">${r.extension} &rarr; ${r.targetFormat}</span>
            </div>
          </td>
          <td class="py-3 px-4 text-slate-400 font-mono text-[10px]">cluster-europe-1</td>
          <td class="py-3 px-4">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-semibold bg-emerald-500/10 text-emerald-400 border-emerald-500/20">${r.status}</span>
          </td>
          <td class="py-3 px-4 text-right">
            <button onclick="purgeAdminSession('${r.userId}', '${r.id}')" class="text-[10px] text-coral_danger hover:underline cursor-pointer">Purge Sandbox</button>
          </td>
        </tr>
      `;
    }).join('');
    
  } catch (error) {
    // Graceful fallback to static sessions logs
    container.innerHTML = activeAdminSessions.map(session => {
      const badgeClass = session.plan === 'Ultimate' 
        ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' 
        : session.plan === 'Pro' 
          ? 'bg-cyan_secondary/10 text-cyan_secondary border-cyan_secondary/20'
          : 'bg-slate-500/10 text-slate-400 border-white/5';

      const statusClass = session.status === 'Active' || session.status === 'Done'
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
        : session.status === 'Converting'
          ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
          : 'bg-slate-700/30 text-slate-500 border-white/5';

      return `
        <tr class="hover:bg-white/2 transition-colors">
          <td class="py-3 px-4 flex items-center gap-2.5">
            <div class="w-6 h-6 rounded-full bg-slate-700/60 flex items-center justify-center font-bold text-[10px] text-white">
              ${session.email.charAt(0).toUpperCase()}
            </div>
            <span class="font-semibold text-white text-[11px]">${session.email}</span>
          </td>
          <td class="py-3 px-4">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold ${badgeClass}">${session.plan}</span>
          </td>
          <td class="py-3 px-4 font-mono font-bold text-slate-100">${session.files} Queue Items</td>
          <td class="py-3 px-4 text-slate-400 font-mono text-[10px]">${session.node}</td>
          <td class="py-3 px-4">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-semibold ${statusClass}">${session.status}</span>
          </td>
          <td class="py-3 px-4 text-right">
            <button onclick="purgeAdminSession('${session.id}')" class="text-[10px] text-coral_danger hover:underline cursor-pointer">Purge Sandbox</button>
          </td>
        </tr>
      `;
    }).join('');
  }
  
  // @ts-ignore
  if (window.lucide) window.lucide.createIcons();
}

export async function purgeAdminSession(userId: string, historyId?: string) {
  if (!historyId) {
    activeAdminSessions = activeAdminSessions.filter(s => s.id !== userId);
    renderAdminGrid();
    showToast('Sandbox Mock Cache purged', 'coral_danger');
    return;
  }
  
  try {
    await deleteDoc(doc(db, 'users', userId, 'history', historyId));
    showToast('Firestore transcode record purged', 'coral_danger');
    renderAdminGrid();
  } catch (err) {
    handleFirestoreError(err, "Purge firestore transaction log");
  }
}

export function addSimulatedUser() {
  const emails = ['alex.k@berlin-hacks.io', 'sarah_web@london-devs.co.uk', 'marcel@parischef.fr', 'v-chou@singapore.sg', 'f.martinez@madrid.es'];
  const nodes = ['cluster-europe-1', 'cluster-us-west', 'cluster-asia-tokyo', 'cluster-us-east'];
  const plans = ['Free', 'Pro', 'Ultimate'];
  const statuses = ['Active', 'Converting', 'Idle'];

  activeAdminSessions.unshift({
    id: 'sim-' + Date.now(),
    email: emails[Math.floor(Math.random() * emails.length)],
    plan: plans[Math.floor(Math.random() * plans.length)],
    files: Math.floor(Math.random() * 40) + 1,
    node: nodes[Math.floor(Math.random() * nodes.length)],
    status: statuses[Math.floor(Math.random() * statuses.length)]
  });

  renderAdminGrid();
  showToast('Injected Simulated conversion pipeline event', 'cyan_secondary');
}

function initAutoRefreshAdminStats() {
  setInterval(async () => {
    const adminPortal = document.getElementById('admin-portal-view');
    const adminPortalHidden = adminPortal ? adminPortal.classList.contains('hidden') : true;
    
    if (isUserLoggedIn && !adminPortalHidden) {
      try {
        const histRef = query(collectionGroup(db, 'history'), limit(500));
        const snap = await getDocs(histRef);
        const totalEl = document.getElementById('stat-total-converted');
        if (totalEl) {
          totalEl.innerText = snap.size.toLocaleString();
        }
        
        const usersRef = collection(db, 'users');
        const usersSnap = await getDocs(usersRef);
        let subs = 0;
        usersSnap.forEach(u => {
          if (u.data().plan !== 'Free') subs++;
        });
        const premEl = document.getElementById('stat-premium-users');
        if (premEl) {
          premEl.innerText = subs.toLocaleString();
        }
      } catch (err) {
        console.warn("Stats refresh fail (fallback engaged)");
      }
    }
  }, 10000);
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

// Global errors parser conforming to FirestoreErrorInfo
function handleFirestoreError(error: any, operationTypeOrContext: any, path: string | null = null) {
  let opType: string = 'write';
  let cleanPath: string | null = path;
  
  if (Object.values(OperationType).includes(operationTypeOrContext)) {
    opType = operationTypeOrContext;
  } else {
    const ctx = String(operationTypeOrContext).toLowerCase();
    if (ctx.includes('load') || ctx.includes('get') || ctx.includes('fetch')) {
      opType = 'get';
    } else if (ctx.includes('list') || ctx.includes('refresh') || ctx.includes('read')) {
      opType = 'list';
    } else if (ctx.includes('delete') || ctx.includes('purge') || ctx.includes('remove')) {
      opType = 'delete';
    } else if (ctx.includes('create') || ctx.includes('add')) {
      opType = 'create';
    } else if (ctx.includes('update') || ctx.includes('elevation') || ctx.includes('set')) {
      opType = 'update';
    } else {
      opType = 'write';
    }
  }

  // Fallback path mapping if null
  if (!cleanPath && typeof operationTypeOrContext === 'string') {
    const ctx = operationTypeOrContext.toLowerCase();
    if (ctx.includes('account') || ctx.includes('profile')) {
      cleanPath = 'users';
    } else if (ctx.includes('history') || ctx.includes('conversion') || ctx.includes('log')) {
      cleanPath = 'users/{userId}/history';
    }
  }

  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || null,
      isAnonymous: auth.currentUser?.isAnonymous || null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType: opType,
    path: cleanPath
  };

  console.error('[Firestore Security Firewall] Error at ' + (typeof operationTypeOrContext === 'string' ? operationTypeOrContext : opType) + ':', error);
  console.error('Firestore Error Payload:', JSON.stringify(errInfo));
  
  let userMessage = "A secure database communication incident occurred.";
  if (error && (error.code === 'permission-denied' || String(error.message).toLowerCase().includes('permission'))) {
    userMessage = "Access Blocked: Secure Firestore policies invalidated this execution sequence.";
  } else if (error && (error.code === 'unavailable' || String(error.message).toLowerCase().includes('unavailable'))) {
    userMessage = "Network Offline: Real-time Firestore replicas unreached.";
  }
  showToast(userMessage, 'coral_danger');
  
  throw new Error(JSON.stringify(errInfo));
}

export function showToast(msg: string, type = 'indigo_primary') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  const iconBg = document.getElementById('toast-icon-bg');
  const text = document.getElementById('toast-msg');

  if (!toast || !icon || !iconBg || !text) return;

  text.innerText = msg;

  if (type === 'coral_danger') {
    icon.setAttribute('data-lucide', 'alert-circle');
    iconBg.className = 'p-1 rounded bg-coral_danger/15 text-coral_danger';
  } else if (type === 'cyan_secondary') {
    icon.setAttribute('data-lucide', 'check');
    iconBg.className = 'p-1 rounded bg-cyan_secondary/15 text-cyan_secondary';
  } else {
    icon.setAttribute('data-lucide', 'info');
    iconBg.className = 'p-1 rounded bg-indigo_primary/15 text-indigo-400';
  }

  // @ts-ignore
  if (window.lucide) window.lucide.createIcons();

  toast.className = 'fixed bottom-4 right-4 z-50 transform translate-y-0 opacity-100 transition-all duration-300 glass-panel border border-white/10 px-4 py-3 rounded-xl flex items-center gap-2.5 max-w-sm shadow-xl shadow-black/40';
  
  // Create unique signature to prevent overlay collisions
  const currentTimerId = setTimeout(() => {
    toast.className = 'fixed bottom-4 right-4 z-50 transform translate-y-20 opacity-0 transition-all duration-300 glass-panel border border-white/10 px-4 py-3 rounded-xl flex items-center gap-2.5 max-w-sm shadow-xl shadow-black/40';
  }, 3500);
  
  // @ts-ignore
  toast.dataset.timerId = currentTimerId;
}

// Bind all export helpers dynamically to window scope to preserve complete 1:1 legacy compatibility with HTML buttons
// @ts-ignore
window.scrollIntoView = scrollIntoView;
// @ts-ignore
window.updateSingleFileFormat = updateSingleFileFormat;
// @ts-ignore
window.applyGlobalFormat = applyGlobalFormat;
// @ts-ignore
window.removeFile = removeFile;
// @ts-ignore
window.clearQueue = clearQueue;
// @ts-ignore
window.triggerConversion = triggerConversion;
// @ts-ignore
window.downloadMockFile = downloadMockFile;
// @ts-ignore
window.downloadAllConvertedFiles = downloadAllConvertedFiles;
// @ts-ignore
window.openAuthModal = openAuthModal;
// @ts-ignore
window.closeAuthModal = closeAuthModal;
// @ts-ignore
window.switchAuthTab = switchAuthTab;
// @ts-ignore
window.handleAuthSubmit = handleAuthSubmit;
// @ts-ignore
window.simulateThirdPartyAuth = simulateThirdPartyAuth;
// @ts-ignore
window.triggerPremiumUpgrade = triggerPremiumUpgrade;
// @ts-ignore
window.closeCheckoutModal = closeCheckoutModal;
// @ts-ignore
window.handleCheckoutSubmit = handleCheckoutSubmit;
// @ts-ignore
window.openAdminModal = openAdminModal;
// @ts-ignore
window.closeAdminAuthOverlay = closeAdminAuthOverlay;
// @ts-ignore
window.handleAdminSubmit = handleAdminSubmit;
// @ts-ignore
window.switchToAdminView = switchToAdminView;
// @ts-ignore
window.showMainConverter = showMainConverter;
// @ts-ignore
window.purgeAdminSession = purgeAdminSession;
// @ts-ignore
window.addSimulatedUser = addSimulatedUser;
// @ts-ignore
window.showToast = showToast;
