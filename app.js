// Supabase
const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' // use o seu
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

// Estado global
let myProfile = null          // { id, photo_url }
let currentConversation = null // { id, partner_id, partner_photo_url }
let activeChannel = null
let waitingChannel = null
let heartbeatInterval = null
let confirmResolver = null

// Helper modal
function showConfirm(msg) { /* igual ao anterior */ }
function resolveConfirm(val) { /* igual */ }

// Navegação
function showScreen(id) { /* igual */ }
function showHome() { disconnectAndClean(); showScreen('screen-home'); refreshOnlineCount(); }
function showPrivacy() { showScreen('screen-privacy'); }

// Upload e criação do perfil
let pendingFile = null
function previewFile(e) { /* igual */ }
function updateSendBtn() { /* igual */ }
function startUpload() { showScreen('screen-upload'); }

async function uploadPhoto() {
  const file = document.getElementById('file-input').files[0]
  if (!file || !document.getElementById('consent-check').checked) return
  const status = document.getElementById('upload-status')
  status.textContent = 'Uploading...'
  
  const ext = file.name.split('.').pop()
  const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadErr } = await db.storage.from('PHOTOS').upload(fileName, file)
  if (uploadErr) { status.textContent = 'Upload failed'; return }
  const { data: urlData } = db.storage.from('PHOTOS').getPublicUrl(fileName)
  const photoUrl = urlData.publicUrl
  
  const { data: profile, error: insertErr } = await db
    .from('chat_profiles')
    .insert({ photo_url: photoUrl, online: true, waiting: true })
    .select()
    .single()
  if (insertErr) { status.textContent = 'Error saving profile'; return }
  
  myProfile = profile
  // Salva o ID secreto no localStorage para recuperação
  localStorage.setItem('my_chat_id', myProfile.id)
  // Entrar na fila de espera
  await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id })
  startWaitingForMatch()
}

function resumeWithId() {
  const id = prompt('Seu ID secreto:')
  if (id && !isNaN(parseInt(id))) {
    localStorage.setItem('my_chat_id', id)
    window.location.reload()
  }
}

// Gerenciamento de presença online (heartbeat)
async function updateOnlineStatus(isOnline) {
  if (!myProfile) return
  await db.from('chat_profiles').update({ online: isOnline, last_seen: new Date() }).eq('id', myProfile.id)
  if (!isOnline && waitingChannel) waitingChannel.unsubscribe()
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

// Fila de espera e pareamento (Omegle style)
async function startWaitingForMatch() {
  showScreen('screen-waiting')
  // Inscrever-se na fila para ouvir novos usuários
  waitingChannel = db.channel('waiting-queue')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_waiting_queue' }, async (payload) => {
      // Checar se já temos um parceiro
      const { data: queue } = await db.from('chat_waiting_queue').select('profile_id').order('joined_at', { ascending: true })
      if (queue && queue.length >= 2) {
        // Pega os dois primeiros
        const p1 = queue[0].profile_id
        const p2 = queue[1].profile_id
        if (p1 === myProfile.id || p2 === myProfile.id) {
          // Tentar criar conversa
          const { data: conv, error } = await db
            .from('chat_conversations')
            .insert({ profile1_id: p1, profile2_id: p2 })
            .select()
            .single()
          if (!error && conv) {
            // Remover ambos da fila
            await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
            // Atualizar perfis com conversa atual
            await db.from('chat_profiles').update({ waiting: false, current_conversation_id: conv.id }).in('id', [p1, p2])
            // Se eu sou um deles, iniciar chat
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
  // Mostrar tela de chat
  document.getElementById('my-photo-img').src = myProfile.photo_url
  document.getElementById('partner-photo-img').src = partner.photo_url
  showScreen('screen-chat')
  await loadMessages(convId)
  subscribeToMessages(convId)
  startHeartbeat()
  // Observar quando o parceiro ficar offline
  watchPartnerStatus(partnerId)
}

async function loadMessages(convId) {
  const { data } = await db.from('chat_messages').select('*').eq('conversation_id', convId).order('created_at')
  const container = document.getElementById('messages-container')
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-chat-msg">Say something to start</div>'
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
  const partnerStatusSpan = document.getElementById('partner-status')
  const partnerChannel = db.channel(`partner-status-${partnerId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_profiles', filter: `id=eq.${partnerId}` }, (payload) => {
      const isOnline = payload.new.online
      partnerStatusSpan.textContent = isOnline ? 'online' : 'offline'
      partnerStatusSpan.style.color = isOnline ? '#9bff9b' : '#888'
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

async function nextChat() {
  const confirmed = await showConfirm('End this chat and find a new partner?')
  if (!confirmed) return
  // Encerrar conversa atual
  if (currentConversation) {
    await db.from('chat_conversations').update({ ended_at: new Date() }).eq('id', currentConversation.id)
    await db.from('chat_profiles').update({ current_conversation_id: null, waiting: true }).eq('id', myProfile.id)
  }
  if (activeChannel) activeChannel.unsubscribe()
  // Voltar para a fila
  await db.from('chat_waiting_queue').insert({ profile_id: myProfile.id, joined_at: new Date() })
  startWaitingForMatch()
}

async function exitChat() {
  if (activeChannel) activeChannel.unsubscribe()
  if (waitingChannel) waitingChannel.unsubscribe()
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  if (myProfile) {
    await updateOnlineStatus(false)
    await db.from('chat_profiles').update({ waiting: false, current_conversation_id: null }).eq('id', myProfile.id)
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
  }
  showHome()
}

function cancelWaiting() {
  if (waitingChannel) waitingChannel.unsubscribe()
  exitChat()
}

async function refreshOnlineCount() {
  const { count } = await db.from('chat_profiles').select('*', { count: 'exact', head: true }).eq('online', true)
  document.getElementById('online-count').innerText = `${count || 0} online now`
  setTimeout(refreshOnlineCount, 15000)
}

function escapeHtml(str) { /* igual */ }

// Inicialização
window.addEventListener('load', async () => {
  const savedId = localStorage.getItem('my_chat_id')
  if (savedId) {
    const { data: profile } = await db.from('chat_profiles').select('*').eq('id', savedId).single()
    if (profile && profile.online === false) {
      myProfile = profile
      await updateOnlineStatus(true)
      // Verificar se já tem conversa ativa
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