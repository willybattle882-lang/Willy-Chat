const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96eWxpZ2lsbnp1aG5ra29iZ3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2ODkyNjMsImV4cCI6MjA5NjI2NTI2M30.H64U-LWB_arJkS_73sMVF-1myh3VhnFnyVCtFjlEDUg'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

let myProfile = null
let currentConversation = null
let activeChannel = null
let matchPollInterval = null
let confirmResolver = null

// ========== MODAL ==========
function showConfirm(msg) {
  document.getElementById('confirm-message').textContent = msg
  document.getElementById('confirm-modal').style.display = 'flex'
  return new Promise(r => { confirmResolver = r })
}
function resolveConfirm(val) {
  document.getElementById('confirm-modal').style.display = 'none'
  if (confirmResolver) confirmResolver(val)
}

// ========== NAVEGAÇÃO ==========
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

function showHome() {
  cleanup()
  showScreen('screen-home')
  refreshOnlineCount()
}

function startUpload() {
  resetUploadForm()
  showScreen('screen-upload')
}

function showResumeScreen() {
  document.getElementById('resume-code-input').value = ''
  document.getElementById('resume-error').textContent = ''
  showScreen('screen-resume')
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
  reader.onload = e => {
    document.getElementById('preview-img').src = e.target.result
    document.getElementById('preview-img').style.display = 'block'
    document.getElementById('upload-placeholder').style.display = 'none'
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
  document.getElementById('btn-send').disabled = true

  const ext = file.name.split('.').pop()
  const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadErr } = await db.storage.from('PHOTOS').upload(fileName, file)
  if (uploadErr) { status.textContent = 'Upload failed. Try again.'; document.getElementById('btn-send').disabled = false; return }

  const { data: urlData } = db.storage.from('PHOTOS').getPublicUrl(fileName)
  const photoUrl = urlData.publicUrl

  // Gera código de 6 dígitos único
  let code, exists = true
  while (exists) {
    code = String(Math.floor(100000 + Math.random() * 900000))
    const { data } = await db.from('chat_profiles').select('id').eq('code', code).maybeSingle()
    exists = !!data
  }

  const { data: profile, error: insertErr } = await db
    .from('chat_profiles')
    .insert({ photo_url: photoUrl, online: true, waiting: false, code })
    .select().single()

  if (insertErr) { status.textContent = 'Error saving profile.'; document.getElementById('btn-send').disabled = false; return }

  myProfile = profile
  localStorage.setItem('my_chat_code', code)
  document.getElementById('profile-code-display').textContent = code
  showScreen('screen-code')
}

function copyCode() {
  const code = document.getElementById('profile-code-display').textContent
  navigator.clipboard.writeText(code).then(() => {
    const btn = event.target
    btn.textContent = '✅ Copied!'
    setTimeout(() => btn.textContent = '📋 Copy code', 2000)
  })
}

// ========== RESUME ==========
async function resumeWithCode() {
  const code = document.getElementById('resume-code-input').value.trim()
  if (code.length !== 6 || isNaN(code)) {
    document.getElementById('resume-error').textContent = 'Enter a valid 6-digit code.'
    return
  }
  const { data: profile } = await db.from('chat_profiles').select('*').eq('code', code).maybeSingle()
  if (!profile) { document.getElementById('resume-error').textContent = 'Code not found.'; return }

  myProfile = profile
  localStorage.setItem('my_chat_code', code)
  await db.from('chat_profiles').update({ online: true }).eq('id', myProfile.id)
  enterQueue()
}

// ========== FILA ==========
async function enterQueue() {
  showScreen('screen-waiting')
  if (matchPollInterval) clearInterval(matchPollInterval)

  // Marca como waiting e entra na fila
  await db.from('chat_profiles').update({ waiting: true, online: true }).eq('id', myProfile.id)
  await db.from('chat_waiting_queue').upsert({ profile_id: myProfile.id, joined_at: new Date().toISOString() })

  // Poll a cada 2s pra ver se foi matcheado
  matchPollInterval = setInterval(async () => {
    // Verifica se já tem conversa ativa
    const { data: conv } = await db.from('chat_conversations')
      .select('*')
      .or(`profile1_id.eq.${myProfile.id},profile2_id.eq.${myProfile.id}`)
      .is('ended_at', null)
      .maybeSingle()

    if (conv) {
      clearInterval(matchPollInterval)
      const partnerId = conv.profile1_id === myProfile.id ? conv.profile2_id : conv.profile1_id
      await startChat(conv, partnerId)
      return
    }

    // Tenta criar match se há 2+ na fila
    const { data: queue } = await db.from('chat_waiting_queue')
      .select('profile_id, joined_at')
      .order('joined_at', { ascending: true })
      .limit(2)

    if (!queue || queue.length < 2) return

    const p1 = queue[0].profile_id
    const p2 = queue[1].profile_id

    // Só o usuário com menor ID na fila tenta criar (evita race condition)
    if (myProfile.id !== p1 && myProfile.id !== p2) return
    if (myProfile.id !== Math.min(p1, p2)) return

    const { data: conv2, error } = await db.from('chat_conversations')
      .insert({ profile1_id: p1, profile2_id: p2 })
      .select().single()

    if (error || !conv2) return // outro já criou

    // Remove os dois da fila
    await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
    await db.from('chat_profiles').update({ waiting: false, current_conversation_id: conv2.id }).in('id', [p1, p2])

  }, 2000)
}

async function startChat(conv, partnerId) {
  const { data: partner } = await db.from('chat_profiles').select('photo_url').eq('id', partnerId).single()
  currentConversation = { id: conv.id, partner_id: partnerId }

  document.getElementById('my-photo-img').src = myProfile.photo_url
  document.getElementById('partner-photo-img').src = partner.photo_url
  document.getElementById('partner-status-label').textContent = 'online'

  showScreen('screen-chat')
  await loadMessages(conv.id)
  subscribeToMessages(conv.id)
  watchPartner(partnerId)
}

// ========== MENSAGENS ==========
async function loadMessages(convId) {
  const { data } = await db.from('chat_messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: true })
  const container = document.getElementById('messages-container')
  container.innerHTML = ''
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-chat-msg">✨ Say something!</div>'
    return
  }
  data.forEach(m => appendMessage(m))
}

function subscribeToMessages(convId) {
  if (activeChannel) activeChannel.unsubscribe()
  activeChannel = db.channel(`chat-${convId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'chat_messages',
      filter: `conversation_id=eq.${convId}`
    }, payload => {
      appendMessage(payload.new)
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

  const { data, error } = await db.from('chat_messages').insert({
    conversation_id: currentConversation.id,
    sender_id: myProfile.id,
    content: text
  }).select().single()

  if (!error && data) appendMessage(data)
}

// ========== PARTNER STATUS ==========
function watchPartner(partnerId) {
  db.channel(`partner-${partnerId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_profiles', filter: `id=eq.${partnerId}` }, payload => {
      const online = payload.new.online
      const label = document.getElementById('partner-status-label')
      label.textContent = online ? 'online' : 'offline'
      label.style.color = online ? '#9bff9b' : '#888'
      if (!online) document.getElementById('chat-status').textContent = 'Partner disconnected. Click Next to find someone else.'
    })
    .subscribe()
}

// ========== NEXT ==========
async function nextChat() {
  const confirmed = await showConfirm('End this conversation and find a new partner?')
  if (!confirmed) return

  if (currentConversation) {
    await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
  }
  if (activeChannel) activeChannel.unsubscribe()
  currentConversation = null
  document.getElementById('chat-status').textContent = ''
  enterQueue()
}

// ========== EXIT ==========
async function cleanup() {
  if (matchPollInterval) clearInterval(matchPollInterval)
  if (activeChannel) { activeChannel.unsubscribe(); activeChannel = null }
  if (myProfile) {
    await db.from('chat_profiles').update({ online: false, waiting: false, current_conversation_id: null }).eq('id', myProfile.id)
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
    if (currentConversation) {
      await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
    }
  }
  currentConversation = null
}

async function exitChat() {
  await cleanup()
  myProfile = null
  showHome()
}

async function cancelWaiting() {
  await cleanup()
  myProfile = null
  showHome()
}

// ========== ONLINE COUNT ==========
async function refreshOnlineCount() {
  const { count } = await db.from('chat_profiles').select('*', { count: 'exact', head: true }).eq('online', true)
  const el = document.getElementById('online-count')
  if (el) el.textContent = `${count || 0} online now`
}

// ========== HELPERS ==========
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))
}

// ========== INIT ==========
window.addEventListener('load', async () => {
  const savedCode = localStorage.getItem('my_chat_code')
  if (savedCode) {
    const { data: profile } = await db.from('chat_profiles').select('*').eq('code', savedCode).maybeSingle()
    if (profile) {
      myProfile = profile
      await db.from('chat_profiles').update({ online: true }).eq('id', myProfile.id)
    } else {
      localStorage.removeItem('my_chat_code')
    }
  }
  showHome()
  refreshOnlineCount()
})

window.addEventListener('beforeunload', () => {
  if (myProfile) db.from('chat_profiles').update({ online: false }).eq('id', myProfile.id)
})
