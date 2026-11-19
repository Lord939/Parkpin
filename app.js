const STORAGE_KEY_ACTIVE = 'parkpin_active_v1';
const STORAGE_KEY_HISTORY = 'parkpin_history_v1';

let activeParking = null;
let pendingPhotoDataUrl = null;
let mapInstance = null;
let carMarker = null;
let userMarker = null;
let watchId = null;
let timerInterval = null;
let deferredInstallPrompt = null;
let alertPlayed = false;

// Elementi DOM
const viewEmpty = document.getElementById('view-empty');
const viewActive = document.getElementById('view-active');
const gpsStatus = document.getElementById('gps-status');
const btnParkNow = document.getElementById('btn-park-now');
const inputNote = document.getElementById('input-note');
const inputTimer = document.getElementById('input-timer');
const inputPhoto = document.getElementById('input-photo');
const previewWrapper = document.getElementById('preview-wrapper');
const photoPreviewImg = document.getElementById('photo-preview-img');
const photoBtnText = document.getElementById('photo-btn-text');

// Inizializzazione
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  bindEvents();
  loadSavedState();
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

function bindEvents() {
  // Chip rapidi
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.chip;
      inputNote.value = inputNote.value ? `${inputNote.value} · ${val}` : val;
    });
  });

  // Gestione foto con compressione
  inputPhoto.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      pendingPhotoDataUrl = await compressImage(file, 900, 0.72);
      photoPreviewImg.src = pendingPhotoDataUrl;
      previewWrapper.classList.remove('hidden');
      photoBtnText.textContent = 'Foto pronta';
    } catch {
      showToast('Impossibile elaborare la foto');
    }
  });

  document.getElementById('btn-remove-photo').addEventListener('click', () => {
    pendingPhotoDataUrl = null;
    inputPhoto.value = '';
    previewWrapper.classList.add('hidden');
    photoBtnText.textContent = 'Scatta foto';
  });

  // Salvataggio parcheggio
  btnParkNow.addEventListener('click', handleParkNow);

  // Azioni sosta attiva
  document.getElementById('btn-extend-timer').addEventListener('click', () => {
    if (!activeParking) return;
    const base = activeParking.expiresAt && activeParking.expiresAt > Date.now()
      ? activeParking.expiresAt
      : Date.now();
    activeParking.expiresAt = base + 15 * 60 * 1000;
    alertPlayed = false;
    saveActiveState();
    updateTimerUI();
    showToast('Timer esteso di 15 minuti');
  });

  document.getElementById('btn-edit-note').addEventListener('click', () => {
    if (!activeParking) return;
    const updated = prompt('Modifica riferimento parcheggio:', activeParking.note || '');
    if (updated !== null) {
      activeParking.note = updated.trim();
      saveActiveState();
      document.getElementById('active-note').textContent = activeParking.note || 'Nessuna nota';
    }
  });

  document.getElementById('btn-share').addEventListener('click', shareParkingLocation);

  document.getElementById('btn-end-parking').addEventListener('click', () => {
    if (!activeParking) return;
    archiveParking(activeParking);
    activeParking = null;
    localStorage.removeItem(STORAGE_KEY_ACTIVE);
    stopTracking();
    renderState();
    showToast('Sosta terminata e salvata nello storico');
  });

  // Storico
  document.getElementById('btn-history').addEventListener('click', openHistoryModal);
  document.getElementById('btn-close-history').addEventListener('click', () => {
    document.getElementById('modal-history').classList.add('hidden');
  });

  // Banner installazione PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('btn-install').classList.remove('hidden');
  });

  document.getElementById('btn-install').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('btn-install').classList.add('hidden');
  });
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ACTIVE);
    if (raw) {
      activeParking = JSON.parse(raw);
    }
  } catch {
    activeParking = null;
  }
  renderState();
}

function saveActiveState() {
  if (activeParking) {
    localStorage.setItem(STORAGE_KEY_ACTIVE, JSON.stringify(activeParking));
  }
}

async function handleParkNow() {
  if (!('geolocation' in navigator)) {
    showToast('GPS non supportato da questo browser');
    return;
  }

  btnParkNow.classList.add('loading');
  gpsStatus.textContent = 'Acquisizione satelliti GPS...';

  // Richiede permesso notifiche se timer impostato
  const timerMinutes = parseInt(inputTimer.value, 10) || 0;
  if (timerMinutes > 0 && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const now = Date.now();
      activeParking = {
        id: `park_${now}`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy),
        timestamp: now,
        note: inputNote.value.trim(),
        photo: pendingPhotoDataUrl,
        expiresAt: timerMinutes > 0 ? now + timerMinutes * 60 * 1000 : null
      };

      alertPlayed = false;
      saveActiveState();
      resetForm();
      btnParkNow.classList.remove('loading');
      renderState();
      showToast('Posizione auto salvata!');
    },
    (err) => {
      btnParkNow.classList.remove('loading');
      gpsStatus.textContent = 'Errore segnale GPS';
      const msg = err.code === 1
        ? 'Permesso posizione negato. Abilitalo nelle impostazioni del browser.'
        : 'Segnale GPS debole. Riprova vicino all’uscita.';
      showToast(msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function resetForm() {
  inputNote.value = '';
  inputTimer.value = '0';
  pendingPhotoDataUrl = null;
  inputPhoto.value = '';
  previewWrapper.classList.add('hidden');
  photoBtnText.textContent = 'Scatta foto';
}

function renderState() {
  if (!activeParking) {
    viewActive.classList.add('hidden');
    viewEmpty.classList.remove('hidden');
    gpsStatus.textContent = 'Pronto al rilevamento';
    return;
  }

  viewEmpty.classList.add('hidden');
  viewActive.classList.remove('hidden');
  gpsStatus.textContent = 'Sosta attiva monitorata';

  const dateObj = new Date(activeParking.timestamp);
  const timeStr = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('active-time-label').textContent = `Parcheggiata alle ${timeStr}`;
  document.getElementById('accuracy-badge').textContent = `Precisione GPS: ±${activeParking.accuracy} m`;
  document.getElementById('active-note').textContent = activeParking.note || 'Nessuna nota';

  // Foto
  const photoBox = document.getElementById('active-photo-box');
  if (activeParking.photo) {
    document.getElementById('active-photo-img').src = activeParking.photo;
    photoBox.classList.remove('hidden');
  } else {
    photoBox.classList.add('hidden');
  }

  // Link navigazione universale
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const navUrl = isIOS
    ? `https://maps.apple.com/?daddr=${activeParking.lat},${activeParking.lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${activeParking.lat},${activeParking.lng}&travelmode=walking`;
  document.getElementById('btn-navigate').href = navUrl;

  initOrUpdateMap();
  startLiveTracking();
  startTimers();
}

function initOrUpdateMap() {
  const { lat, lng } = activeParking;

  if (!mapInstance) {
    mapInstance = L.map('map', { zoomControl: false }).setView([lat, lng], 17);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(mapInstance);
  } else {
    mapInstance.setView([lat, lng], 17);
  }

  if (carMarker) mapInstance.removeLayer(carMarker);

  const carIcon = L.divIcon({
    className: 'custom-car-pin',
    html: `<div style="background:#3b82f6;color:#fff;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:800;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.5);">P</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

  carMarker = L.marker([lat, lng], { icon: carIcon }).addTo(mapInstance);
  setTimeout(() => mapInstance.invalidateSize(), 200);
}

function startLiveTracking() {
  stopTracking();
  if (!('geolocation' in navigator)) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!activeParking) return;
      const uLat = pos.coords.latitude;
      const uLng = pos.coords.longitude;

      const meters = calculateDistanceMeters(uLat, uLng, activeParking.lat, activeParking.lng);
      const distValEl = document.getElementById('dist-value');
      const distUnitEl = document.getElementById('dist-unit');

      if (meters >= 1000) {
        distValEl.textContent = (meters / 1000).toFixed(1);
        distUnitEl.textContent = 'km';
      } else {
        distValEl.textContent = Math.round(meters);
        distUnitEl.textContent = 'm';
      }

      if (mapInstance) {
        if (userMarker) {
          userMarker.setLatLng([uLat, uLng]);
        } else {
          userMarker = L.circleMarker([uLat, uLng], {
            radius: 7,
            fillColor: '#10b981',
            color: '#fff',
            weight: 2,
            fillOpacity: 1
          }).addTo(mapInstance);
        }
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTimers() {
  updateTimerUI();
  timerInterval = setInterval(updateTimerUI, 1000);
}

function updateTimerUI() {
  if (!activeParking) return;

  // Tempo trascorso
  const elapsedMins = Math.floor((Date.now() - activeParking.timestamp) / 60000);
  const hours = Math.floor(elapsedMins / 60);
  const mins = elapsedMins % 60;
  document.getElementById('active-elapsed').textContent =
    hours > 0 ? `Tempo trascorso: ${hours}h ${mins}m` : `Tempo trascorso: ${mins} min`;

  // Countdown parcometro
  const banner = document.getElementById('timer-banner');
  const countdownEl = document.getElementById('timer-countdown');

  if (!activeParking.expiresAt) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  const diff = activeParking.expiresAt - Date.now();

  if (diff <= 0) {
    banner.classList.add('expired');
    countdownEl.textContent = 'SCADUTO';
    if (!alertPlayed) {
      alertPlayed = true;
      triggerExpiryAlert();
    }
    return;
  }

  banner.classList.remove('expired');
  const totalSec = Math.floor(diff / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  countdownEl.textContent = `${h}:${m}:${s}`;
}

function triggerExpiryAlert() {
  if ('vibrate' in navigator) navigator.vibrate([300, 150, 300]);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('ParkPin — Parcometro scaduto!', {
      body: 'Il tempo impostato per la sosta è terminato.'
    });
  }
}

function shareParkingLocation() {
  if (!activeParking) return;
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${activeParking.lat},${activeParking.lng}`;
  const text = `Ho parcheggiato qui${activeParking.note ? ` (${activeParking.note})` : ''}: ${mapsLink}`;

  if (navigator.share) {
    navigator.share({ title: 'Posizione auto', text, url: mapsLink }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(text);
    showToast('Link posizione copiato negli appunti');
  }
}

function archiveParking(parking) {
  try {
    const history = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]');
    // Non salviamo la foto pesante nello storico per mantenere leggerezza
    const { photo, ...lightEntry } = parking;
    lightEntry.endedAt = Date.now();
    history.unshift(lightEntry);
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history.slice(0, 15)));
  } catch {}
}

function openHistoryModal() {
  const listEl = document.getElementById('history-list');
  const history = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]');

  if (history.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;">Nessuna sosta precedente registrata.</p>';
  } else {
    listEl.innerHTML = history.map(item => {
      const d = new Date(item.timestamp).toLocaleString('it-IT', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const url = `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`;
      return `
        <div class="history-item">
          <div>
            <strong>${item.note || 'Parcheggio salvato'}</strong>
            <span>${d} · ${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}</span>
          </div>
          <a href="${url}" target="_blank" rel="noopener" class="btn-small" style="text-decoration:none;">Mappa</a>
        </div>
      `;
    }).join('');
  }

  document.getElementById('modal-history').classList.remove('hidden');
}

// Utility: Formula di Haversine per distanza in metri
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Utility: Compressione immagine lato client
function compressImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = event.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('hidden'), 3000);
}