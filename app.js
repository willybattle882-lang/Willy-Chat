// Supabase
const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96eWxpZ2lsbnp1aG5ra29iZ3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2ODkyNjMsImV4cCI6MjA5NjI2NTI2M30.H64U-LWB_arJkS_73sMVF-1myh3VhnFnyVCtFjlEDUg'
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

// Estado global
let myProfile = null          // { id, photo_url }
let currentConversation = null // { id, partner_id, partner_photo_url }
let activeChannel = null
let waitingChannel = null
let heartbeatInterval = null
let partnerStatusChannel = null
let confirmResolver = null

// ========== MODAL ==========
function showConfirm(message) {
  document.getElementById('confirm-message').textContent = message
  const modal = document.getElementById('confirm-modal')
  modal.style.display = 'flex'
  return new Promise(resolve => { confirmResolver = resolve })
}
function resolveConfirm(value) {
  document.getElementById('confirm-modal').style.display = 'none'
  if (confirmResolver) confirmResolver(value)
}

// ========== NAVEGAÇÃO ==========
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

function showHome() {
  disconnectAndClean()
  showScreen('screen-home')
  refreshOnlineCount()
}

function showPrivacy() {
  showScreen('screen-privacy')
}

function startUpload() {
  showScreen('screen-upload')
  resetUploadForm()
}

// ========== UPLOAD ==========
function updateSendBtn() {
  const hasFile = document.getElementById('file-input').files.length > 0
  const hasConsent = document.getElementById('consent-check').checked
  document.getElementById('btn-send').disabled = !(hasFile && hasConsent)
}

function previewFile(event) {
  const file = event.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = document.getElementById('preview-img')
    const placeholder = document.getElementById('upload-placeholder')
    img.src = e.target.result
    img.style.display = 'block'
    placeholder.style.display = 'none'
  }
  reader.readAsDataURL(file)
  updateSendBtn()
}

function resetUploadForm() {
  document.getElementById('file-input').value = ''
  document.getElementById('preview-img').style.display = 'none'
  document.getElementById('upload-placeholder').style.display = 'flex'
  document.getElementById('consent-check').checked = false
  document.getElementById('upload-status').textContent = ''
  updateSendBtn()
}

async function uploadPhoto() {
  const file = document.getElementById('file-input').files[0]
  if (!file || !document.getElementById('consent-check').checked) return

  const status = document.getElementById('upload-status')
  status.textContent = 'Uploading...'
  const btn = document.getElementById('btn-send')
  btn.disabled = true

  const ext = file.name.split('.').pop()
  const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadErr } = await db.storage.from('PHOTOS').upload(fileName, file)
  if (uploadErr) {
    status.textContent = 'Upload failed'
    btn.disabled = false
    return
  }
  const { data: urlData } = db.storage.from('PHOTOS').getPublicUrl(fileName)
  const photoUrl = urlData.publicUrl

  const { data: profile, error: insertErr } = await db
    .from('chat_profiles')
    .insert({ photo_url: photoUrl, online: true, waiting: true })
    .select()
    .single()
  if (insertErr) {
    status.textContent = 'Error saving profile'
    btn.disabled = false
    return
  }

  myProfile = profile
  localStorage.setItem('my_chat_id', myProfile.id)
  // Entrar na fila
  await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id })
  startWaitingForMatch()
}

function resumeWithId() {
  const id = prompt('Your secret ID:')
  if (id && !isNaN(parseInt(id))) {
    localStorage.setItem('my_chat_id', id)
    window.location.reload()
  }
}

// ========== PRESENÇA ONLINE ==========
async function updateOnlineStatus(isOnline) {
  if (!myProfile) return
  await db.from('chat_profiles').update({ online: isOnline, last_seen: new Date() }).eq('id', myProfile.id)
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  heartbeatInterval = setInterval(() => {
    if (myProfile) updateOnlineStatus(true)
  }, 20000)
  window.addEventListener('beforeunload', () => {
    if (myProfile) updateOnlineStatus(false)
  })
}

// ========== FILA E MATCH (Omegle style) ==========
async function startWaitingForMatch() {
  showScreen('screen-waiting')
  // Inscrever na fila
  if (waitingChannel) waitingChannel.unsubscribe()
  waitingChannel = db.channel('waiting-queue')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_waiting_queue' }, async () => {
      const { data: queue } = await db.from('chat_waiting_queue').select('profile_id').order('joined_at', { ascending: true })
      if (queue && queue.length >= 2) {
        const p1 = queue[0].profile_id
        const p2 = queue[1].profile_id
        // Evitar criar conversa duplicada
        const { data: existing } = await db
          .from('chat_conversations')
          .select('id')
          .or(`and(profile1_id.eq.${p1},profile2_id.eq.${p2}),and(profile1_id.eq.${p2},profile2_id.eq.${p1})`)
          .is('ended_at', null)
          .maybeSingle()
        if (existing) return

        if (p1 === myProfile.id || p2 === myProfile.id) {
          const { data: conv, error } = await db
            .from('chat_conversations')
            .insert({ profile1_id: p1, profile2_id: p2 })
            .select()
            .single()
          if (!error && conv) {
            await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
            await db.from('chat_profiles').update({ waiting: false, current_conversation_id: conv.id }).in('id', [p1, p2])
            if (p1 === myProfile.id || p2 === myProfile.id) {
              const partnerId = p1 === myProfile.id ? p2 : p1
              await loadChatAfterMatch(conv.id, partnerId)
            }
          }
        }
      }
    })
    .subscribe()

  // Garantir que este usuário está na fila
  await db.from('chat_waiting_queue').upsert({ profile_id: myProfile.id, joined_at: new Date() })
}

async function loadChatAfterMatch(convId, partnerId) {
  if (waitingChannel) waitingChannel.unsubscribe()
  const { data: partner } = await db.from('chat_profiles').select('photo_url').eq('id', partnerId).single()
  currentConversation = { id: convId, partner_id: partnerId, partner_photo_url: partner.photo_url }

  document.getElementById('my-photo-img').src = myProfile.photo_url
  document.getElementById('partner-photo-img').src = partner.photo_url
  showScreen('screen-chat')
  await loadMessages(convId)
  subscribeToMessages(convId)
  startHeartbeat()
  watchPartnerStatus(partnerId)
}

async function loadMessages(convId) {
  const { data } = await db.from('chat_messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: true })
  const container = document.getElementById('messages-container')
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-chat-msg">✨ No messages yet. Say something!</div>'
    return
  }
  container.innerHTML = data.map(m => `
    <div class="message ${m.sender_id === myProfile.id ? 'own' : ''}">
      ${escapeHtml(m.content)}<small>${new Date(m.created_at).toLocaleTimeString()}</small>
    </div>
  `).join('')
  container.scrollTop = container.scrollHeight
}

function subscribeToMessages(convId) {
  if (activeChannel) activeChannel.unsubscribe()
  activeChannel = db.channel(`chat-${convId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${convId}` }, (payload) => {
      if (payload.new.sender_id !== myProfile.id) appendMessage(payload.new)
    })
    .subscribe()
}

function appendMessage(msg) {
  const container = document.getElementById('messages-container')
  const empty = container.querySelector('.empty-chat-msg')
  if (empty) empty.remove()
  const div = document.createElement('div')
  div.className = `message ${msg.sender_id === myProfile.id ? 'own' : ''}`
  div.innerHTML = `${escapeHtml(msg.content)}<small>${new Date(msg.created_at).toLocaleTimeString()}</small>`
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

async function sendMessage() {
  const input = document.getElementById('message-input')
  const text = input.value.trim()
  if (!text || !currentConversation) return
  input.value = ''
  await db.from('chat_messages').insert({
    conversation_id: currentConversation.id,
    sender_id: myProfile.id,
    content: text
  })
}

function watchPartnerStatus(partnerId) {
  if (partnerStatusChannel) partnerStatusChannel.unsubscribe()
  partnerStatusChannel = db.channel(`partner-status-${partnerId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_profiles', filter: `id=eq.${partnerId}` }, (payload) => {
      const isOnline = payload.new.online
      const statusSpan = document.getElementById('partner-status')
      statusSpan.textContent = isOnline ? 'online' : 'offline'
      statusSpan.style.color = isOnline ? '#9bff9b' : '#888'
      if (!isOnline) {
        document.getElementById('chat-status').textContent = 'Partner disconnected. Click Next to find someone else.'
        document.getElementById('next-btn').style.background = '#ff3c3c'
      } else {
        document.getElementById('chat-status').textContent = ''
        document.getElementById('next-btn').style.background = ''
      }
    })
    .subscribe()
}

// ========== NEXT CONVERSATION ==========
async function nextChat() {
  const confirmed = await showConfirm('End this conversation and find a new partner?')
  if (!confirmed) return

  // Encerrar conversa atual
  if (currentConversation) {
    await db.from('chat_conversations').update({ ended_at: new Date() }).eq('id', currentConversation.id)
    await db.from('chat_profiles').update({ current_conversation_id: null, waiting: true }).eq('id', myProfile.id)
  }
  if (activeChannel) activeChannel.unsubscribe()
  if (partnerStatusChannel) partnerStatusChannel.unsubscribe()

  // Voltar para fila
  await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id, joined_at: new Date() })
  startWaitingForMatch()
}

// ========== EXIT / CLEANUP ==========
async function disconnectAndClean() {
  if (activeChannel) activeChannel.unsubscribe()
  if (waitingChannel) waitingChannel.unsubscribe()
  if (partnerStatusChannel) partnerStatusChannel.unsubscribe()
  if (heartbeatInterval) clearInterval(heartbeatInterval)

  if (myProfile) {
    await updateOnlineStatus(false)
    await db.from('chat_profiles').update({ waiting: false, current_conversation_id: null }).eq('id', myProfile.id)
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
  }
  myProfile = null
  currentConversation = null
}

async function exitChat() {
  await disconnectAndClean()
  localStorage.removeItem('my_chat_id')
  showHome()
}

function cancelWaiting() {
  exitChat()
}

// ========== ONLINE COUNT ==========
async function refreshOnlineCount() {
  const { count } = await db.from('chat_profiles').select('*', { count: 'exact', head: true }).eq('online', true)
  const el = document.getElementById('online-count')
  if (el) el.innerText = `${count || 0} online now`
  setTimeout(refreshOnlineCount, 15000)
}

// ========== HELPERS ==========
function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;'
    if (m === '<') return '&lt;'
    if (m === '>') return '&gt;'
    return m
  })
}

// ========== INIT ==========
window.addEventListener('load', async () => {
  const savedId = localStorage.getItem('my_chat_id')
  if (savedId) {
    const { data: profile } = await db.from('chat_profiles').select('*').eq('id', savedId).single()
    if (profile && profile.online === false) {
      myProfile = profile
      await updateOnlineStatus(true)
      // Verificar conversa ativa
      const { data: conv } = await db.from('chat_conversations').select('*')
        .or(`profile1_id.eq.${myProfile.id},profile2_id.eq.${myProfile.id}`)
        .is('ended_at', null)
        .single()
      if (conv) {
        const partnerId = conv.profile1_id === myProfile.id ? conv.profile2_id : conv.profile1_id
        const { data: partner } = await db.from('chat_profiles').select('photo_url').eq('id', partnerId).single()
        if (partner) {
          currentConversation = { id: conv.id, partner_id: partnerId, partner_photo_url: partner.photo_url }
          document.getElementById('my-photo-img').src = myProfile.photo_url
          document.getElementById('partner-photo-img').src = partner.photo_url
          showScreen('screen-chat')
          await loadMessages(conv.id)
          subscribeToMessages(conv.id)
          watchPartnerStatus(partnerId)
          startHeartbeat()
          return
        }
      }
      // Se não tinha conversa ativa, entra na fila
      await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id })
      startWaitingForMatch()
    } else {
      localStorage.removeItem('my_chat_id')
      showHome()
    }
  } else {
    showHome()
  }
  refreshOnlineCount()
})