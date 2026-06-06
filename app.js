const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96eWxpZ2lsbnp1aG5ra29iZ3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2ODkyNjMsImV4cCI6MjA5NjI2NTI2M30.H64U-LWB_arJkS_73sMVF-1myh3VhnFnyVCtFjlEDUg'
const ADMIN_HASH = 'd5764cde6afed69a3f868d9341685ca39cfd57ab0c7d7d6f7ed60be03c705255'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

let myProfile = null
let currentConversation = null
let activeChannel = null
let matchPollInterval = null
let confirmResolver = null
let autoNextTimeout = null
let isMatching = false
let isStartingChat = false      // Evita múltiplas inicializações do chat

// ========== Helper: URL da imagem (sem transformação) ==========
function getDisplayUrl(originalUrl) {
  if (!originalUrl) return ''
  return originalUrl   // Usa URL original – a conversão HEIC será feita pelo navegador se suportado
}

// ========== HASH ==========
async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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
  if (file.type === 'image/heic' || file.name.toLowerCase().endsWith('.heic')) {
    document.getElementById('upload-status').textContent = '⚠️ HEIC file – preview not available, but upload will work.'
  } else {
    const reader = new FileReader()
    reader.onload = e => {
      document.getElementById('preview-img').src = e.target.result
      document.getElementById('preview-img').style.display = 'block'
      document.getElementById('upload-placeholder').style.display = 'none'
      document.getElementById('upload-status').textContent = ''
    }
    reader.readAsDataURL(file)
  }
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

function copyCode(btn) {
  const code = document.getElementById('profile-code-display').textContent
  navigator.clipboard.writeText(code).then(() => {
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

// ========== MATCH (corrigido) ==========
async function enterQueue() {
  if (isMatching) {
    console.log('[enterQueue] Já está pareando, ignorando...')
    return
  }
  isMatching = true
  try {
    showScreen('screen-waiting')
    if (matchPollInterval) clearInterval(matchPollInterval)

    console.log('[enterQueue] Atualizando status online e waiting para ID:', myProfile.id)
    await db.from('chat_profiles').update({ waiting: true, online: true }).eq('id', myProfile.id)

    // Limpa entrada anterior na fila e insere nova
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
    await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id, joined_at: new Date().toISOString() })

    // Verifica se foi inserido
    const { data: check } = await db.from('chat_waiting_queue').select('profile_id').eq('profile_id', myProfile.id).maybeSingle()
    if (!check) {
      console.error('[enterQueue] Falha ao inserir na fila!')
      document.getElementById('waiting-sub').textContent = 'Error entering queue. Try again.'
      isMatching = false
      return
    }
    console.log('[enterQueue] Perfil confirmado na fila')

    matchPollInterval = setInterval(async () => {
      // Se já está em chat, não faz nada
      if (currentConversation || isStartingChat) return

      // Verifica se já entrou em conversa
      const { data: conv } = await db.from('chat_conversations')
        .select('*')
        .or(`profile1_id.eq.${myProfile.id},profile2_id.eq.${myProfile.id}`)
        .is('ended_at', null)
        .maybeSingle()
      if (conv) {
        console.log('[match] Já estou em conversa ativa, ID:', conv.id)
        clearInterval(matchPollInterval)
        const partnerId = conv.profile1_id === myProfile.id ? conv.profile2_id : conv.profile1_id
        await startChat(conv, partnerId)
        isMatching = false
        return
      }

      // Pega os dois primeiros da fila
      const { data: queue } = await db.from('chat_waiting_queue')
        .select('profile_id')
        .order('joined_at', { ascending: true })
        .limit(2)

      if (!queue || queue.length < 2) return

      let p1 = queue[0].profile_id
      let p2 = queue[1].profile_id

      // Se eu não estiver entre os dois primeiros, não faço nada
      if (myProfile.id !== p1 && myProfile.id !== p2) return

      // Garante que myProfile é o primeiro (p1)
      if (myProfile.id === p2) {
        [p1, p2] = [p2, p1]
      }

      console.log(`[match] Tentando parear ${p1} (eu) com ${p2}`)

      // Verifica se já existe conversa ativa entre eles
      const { data: existing } = await db
        .from('chat_conversations')
        .select('id')
        .or(`and(profile1_id.eq.${p1},profile2_id.eq.${p2}),and(profile1_id.eq.${p2},profile2_id.eq.${p1})`)
        .is('ended_at', null)
        .maybeSingle()
      if (existing) {
        console.log('[match] Já existe conversa ativa, removendo da fila')
        await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
        return
      }

      // Cria conversa
      const { data: conv2, error } = await db.from('chat_conversations')
        .insert({ profile1_id: p1, profile2_id: p2 })
        .select()
        .single()

      if (error) {
        console.error('[match] Erro ao criar conversa:', error.message)
        if (error.code === '23505') {
          await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
        }
        return
      }

      console.log('[match] Conversa criada com sucesso:', conv2.id)

      // Remove da fila
      await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
      await db.from('chat_profiles').update({ waiting: false, current_conversation_id: conv2.id }).in('id', [p1, p2])

      // Inicia chat
      clearInterval(matchPollInterval)
      await startChat(conv2, p2)
      isMatching = false
    }, 2000)
  } catch (err) {
    console.error('[enterQueue] Erro inesperado:', err)
    isMatching = false
  }
}

async function startChat(conv, partnerId) {
  if (isStartingChat) {
    console.log('[startChat] Já iniciando chat, ignorando...')
    return
  }
  isStartingChat = true
  try {
    console.log('[startChat] Iniciando chat com partner:', partnerId)
    const { data: partner } = await db.from('chat_profiles').select('photo_url').eq('id', partnerId).single()
    if (!partner) {
      console.error('[startChat] Partner não encontrado')
      enterQueue()
      return
    }

    currentConversation = { id: conv.id, partner_id: partnerId }

    const myPhotoUrl = getDisplayUrl(myProfile.photo_url)
    const partnerPhotoUrl = getDisplayUrl(partner.photo_url)

    const myImg = document.getElementById('my-photo-img')
    const partnerImg = document.getElementById('partner-photo-img')
    myImg.src = myPhotoUrl
    partnerImg.src = partnerPhotoUrl

    // Tratamento de erro para imagens
    myImg.onerror = () => { console.error('Erro ao carregar minha foto:', myPhotoUrl) }
    partnerImg.onerror = () => { console.error('Erro ao carregar foto do parceiro:', partnerPhotoUrl) }

    document.getElementById('partner-status-label').textContent = 'online'
    document.getElementById('partner-status-label').style.color = '#9bff9b'
    document.getElementById('chat-status').textContent = ''

    showScreen('screen-chat')
    await loadMessages(conv.id)
    subscribeToMessages(conv.id)
    watchPartner(partnerId)
  } finally {
    isStartingChat = false
  }
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

  const { data, error } = await db.from('chat_messages').insert({
    conversation_id: currentConversation.id,
    sender_id: myProfile.id,
    content: text
  }).select().single()

  if (!error && data) appendMessage(data)
}

// ========== PARTNER STATUS (CORRIGIDO) ==========
function watchPartner(partnerId) {
  const channel = db.channel(`partner-${partnerId}`)
  
  channel.on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'chat_profiles',
    filter: `id=eq.${partnerId}`
  }, payload => {
    const online = payload.new.online
    const label = document.getElementById('partner-status-label')
    label.textContent = online ? 'online' : 'offline'
    label.style.color = online ? '#9bff9b' : '#888'

    if (!online) {
      document.getElementById('chat-status').textContent = 'Partner disconnected. Finding someone new in 5s...'
      if (autoNextTimeout) clearTimeout(autoNextTimeout)
      autoNextTimeout = setTimeout(async () => {
        if (currentConversation) {
          await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
        }
        if (activeChannel) activeChannel.unsubscribe()
        currentConversation = null
        document.getElementById('chat-status').textContent = ''
        enterQueue()
      }, 5000)
    } else {
      if (autoNextTimeout) clearTimeout(autoNextTimeout)
      document.getElementById('chat-status').textContent = ''
    }
  })
  
  channel.subscribe()
}

// ========== NEXT ==========
async function nextChat() {
  const confirmed = await showConfirm('End this conversation and find a new partner?')
  if (!confirmed) return
  if (autoNextTimeout) clearTimeout(autoNextTimeout)
  if (currentConversation) {
    await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
  }
  if (activeChannel) activeChannel.unsubscribe()
  currentConversation = null
  document.getElementById('chat-status').textContent = ''
  enterQueue()
}

// ========== EXIT / CLEANUP ==========
async function cleanup() {
  if (matchPollInterval) clearInterval(matchPollInterval)
  if (autoNextTimeout) clearTimeout(autoNextTimeout)
  if (activeChannel) { activeChannel.unsubscribe(); activeChannel = null }
  if (myProfile) {
    await db.from('chat_profiles').update({ online: false, waiting: false, current_conversation_id: null }).eq('id', myProfile.id)
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
    if (currentConversation) {
      await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
    }
  }
  currentConversation = null
  isMatching = false
  isStartingChat = false
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

// ========== ADMIN ==========
function showAdminLogin() {
  document.getElementById('admin-password').value = ''
  document.getElementById('admin-login-error').textContent = ''
  showScreen('screen-admin-login')
}

async function adminLogin() {
  const password = document.getElementById('admin-password').value
  const hash = await hashPassword(password)
  if (hash !== ADMIN_HASH) {
    document.getElementById('admin-login-error').textContent = 'Wrong password.'
    return
  }
  loadAdminPanel()
}

async function loadAdminPanel() {
  showScreen('screen-admin')
  document.getElementById('admin-conversations').innerHTML = '<p class="status-msg">Loading...</p>'

  const { data: convs } = await db.from('chat_conversations')
    .select('*, p1:chat_profiles!profile1_id(photo_url, code, online), p2:chat_profiles!profile2_id(photo_url, code, online)')
    .order('started_at', { ascending: false })
    .limit(50)

  if (!convs || convs.length === 0) {
    document.getElementById('admin-conversations').innerHTML = '<p class="status-msg">No conversations yet.</p>'
    return
  }

  document.getElementById('admin-conversations').innerHTML = convs.map(c => `
    <div class="admin-conv-card" onclick="loadAdminConvMessages(${c.id}, this)">
      <div class="admin-conv-header">
        <div class="admin-photos">
          <img src="${getDisplayUrl(c.p1.photo_url)}" class="admin-thumb" />
          <span class="admin-code">#${c.p1.code}</span>
          <span class="admin-online ${c.p1.online ? 'on' : ''}"></span>
        </div>
        <span class="vs-small">💬</span>
        <div class="admin-photos">
          <img src="${getDisplayUrl(c.p2.photo_url)}" class="admin-thumb" />
          <span class="admin-code">#${c.p2.code}</span>
          <span class="admin-online ${c.p2.online ? 'on' : ''}"></span>
        </div>
        <div class="admin-meta">
          <span class="${c.ended_at ? 'ended' : 'active'}">${c.ended_at ? '⚫ Ended' : '🟢 Active'}</span>
          <small>${new Date(c.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
        </div>
      </div>
      <div class="admin-messages" id="admin-msgs-${c.id}" style="display:none"></div>
    </div>
  `).join('')
}

async function loadAdminConvMessages(convId, card) {
  const msgDiv = document.getElementById(`admin-msgs-${convId}`)
  if (msgDiv.style.display !== 'none') { msgDiv.style.display = 'none'; return }

  msgDiv.style.display = 'block'
  msgDiv.innerHTML = '<p class="status-msg">Loading messages...</p>'

  const { data: msgs } = await db.from('chat_messages')
    .select('content, created_at, sender_id')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })

  if (!msgs || msgs.length === 0) {
    msgDiv.innerHTML = '<p class="status-msg">No messages in this conversation.</p>'
    return
  }

  msgDiv.innerHTML = msgs.map(m => `
    <div class="admin-msg">
      <small>${new Date(m.created_at).toLocaleTimeString()}</small>
      <span>${escapeHtml(m.content)}</span>
    </div>
  `).join('')
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
    console.log('[init] Código salvo encontrado:', savedCode)
    const { data: profile } = await db.from('chat_profiles').select('*').eq('code', savedCode).maybeSingle()
    if (profile) {
      myProfile = profile
      await db.from('chat_profiles').update({ online: true }).eq('id', myProfile.id)
      // Verificar se já está em conversa ativa
      const { data: activeConv } = await db.from('chat_conversations')
        .select('*')
        .or(`profile1_id.eq.${myProfile.id},profile2_id.eq.${myProfile.id}`)
        .is('ended_at', null)
        .maybeSingle()
      if (activeConv) {
        console.log('[init] Conversa ativa encontrada, iniciando chat')
        const partnerId = activeConv.profile1_id === myProfile.id ? activeConv.profile2_id : activeConv.profile1_id
        await startChat(activeConv, partnerId)
      } else {
        console.log('[init] Sem conversa ativa, entrando na fila')
        enterQueue()
      }
      return
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
