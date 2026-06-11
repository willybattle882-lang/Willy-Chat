const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96eWxpZ2lsbnp1aG5ra29iZ3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2ODkyNjMsImV4cCI6MjA5NjI2NTI2M30.H64U-LWB_arJkS_73sMVF-1myh3VhnFnyVCtFjlEDUg'
const ADMIN_HASH = 'd5764cde6afed69a3f868d9341685ca39cfd57ab0c7d7d6f7ed60be03c705255'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

// Estado
let myProfile = null
let currentConversation = null
let activeChannel = null
let matchPollInterval = null
let convPollInterval = null
let confirmResolver = null
let autoNextTimeout = null
let isMatching = false

// Hall of Fame
let currentPhotoId = null
let myLikedPhotos = JSON.parse(localStorage.getItem('liked_photos') || '[]')
let replyTargetId = null

// Battle
let battleLeft = null
let battleRight = null
let battlePool = []
let battleSeen = []
let battleRound = 0
const BATTLE_MAX_ROUNDS = 10

// ========== APELIDOS ==========
const ALIASES_ADJ = ['Silent','Dark','Lonely','Wild','Mystic','Brave','Fierce','Bold','Sneaky','Calm','Swift','Lazy','Cunning','Gentle','Sharp']
const ALIASES_NOUN = ['Wolf','Fox','Bear','Hawk','Tiger','Panther','Eagle','Raven','Lion','Cobra','Shark','Falcon','Otter','Lynx','Viper']
function randomAlias() {
  const adj = ALIASES_ADJ[Math.floor(Math.random() * ALIASES_ADJ.length)]
  const noun = ALIASES_NOUN[Math.floor(Math.random() * ALIASES_NOUN.length)]
  return `${adj} ${noun}`
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
  document.getElementById('gallery-consent-check').checked = false
  document.getElementById('upload-status').textContent = ''
  updateSendBtn()
}

async function uploadPhoto() {
  const file = document.getElementById('file-input').files[0]
  if (!file || !document.getElementById('consent-check').checked) return

  const galleryConsent = document.getElementById('gallery-consent-check').checked
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
    .insert({ photo_url: photoUrl, online: true, waiting: false, code, gallery_consent: galleryConsent })
    .select().single()

  if (insertErr) { status.textContent = 'Error saving profile.'; document.getElementById('btn-send').disabled = false; return }

  myProfile = profile
  localStorage.setItem('my_chat_code', code)

  // Se deu consent, adiciona na galeria
  if (galleryConsent) {
    await db.from('gallery_photos').insert({ profile_id: myProfile.id, photo_url: photoUrl })
  }

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

  // Mostra stats do perfil
  await loadProfileStats(profile)
}

async function giveGalleryConsent() {
  if (!myProfile) return
  await db.from('chat_profiles').update({ gallery_consent: true }).eq('id', myProfile.id)
  // Verifica se já está na galeria
  const { data: existing } = await db.from('gallery_photos').select('id').eq('profile_id', myProfile.id).maybeSingle()
  if (!existing) {
    await db.from('gallery_photos').insert({ profile_id: myProfile.id, photo_url: myProfile.photo_url })
  }
  enterQueue()
}

// ========== PROFILE STATS ==========
async function loadProfileStats(profile) {
  document.getElementById('stats-photo').src = profile.photo_url
  
  // Busca foto na galeria
  const { data: galleryPhoto } = await db.from('gallery_photos')
    .select('id, votes, losses, championships')
    .eq('profile_id', profile.id)
    .maybeSingle()

  if (galleryPhoto) {
    document.getElementById('stats-wins').textContent = galleryPhoto.votes || 0
    document.getElementById('stats-losses').textContent = galleryPhoto.losses || 0
    document.getElementById('stats-champ').textContent = galleryPhoto.championships || 0
    document.getElementById('stats-gallery-note').textContent = 'Your photo is in the Hall of Fame ✅'
  } else {
    document.getElementById('stats-wins').textContent = '—'
    document.getElementById('stats-losses').textContent = '—'
    document.getElementById('stats-champ').textContent = '—'
    document.getElementById('stats-gallery-note').textContent = 'Your photo is not in the Hall of Fame yet'
  }

  showScreen('screen-profile-stats')
}

// ========== FILA ==========
async function enterQueue() {
  if (isMatching) {
    console.log('[enterQueue] Já está pareando, ignorando...')
    return
  }
  isMatching = true
  showScreen('screen-waiting')
  if (matchPollInterval) clearInterval(matchPollInterval)

  console.log('[enterQueue] Atualizando status online e waiting para ID:', myProfile.id)
  await db.from('chat_profiles').update({ waiting: true, online: true }).eq('id', myProfile.id)
  await db.from('chat_waiting_queue').upsert({ profile_id: myProfile.id, joined_at: new Date().toISOString() })
  console.log('[enterQueue] Perfil confirmado na fila')

  matchPollInterval = setInterval(async () => {
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

    const { data: queue } = await db.from('chat_waiting_queue')
      .select('profile_id, joined_at')
      .order('joined_at', { ascending: true })
      .limit(2)

    if (!queue || queue.length < 2) return

    const p1 = queue[0].profile_id
    const p2 = queue[1].profile_id
    if (myProfile.id !== p1 && myProfile.id !== p2) return
    if (myProfile.id !== Math.min(p1, p2)) return

    console.log('[match] Tentando parear', p1, 'com', p2)
    const { data: conv2, error } = await db.from('chat_conversations')
      .insert({ profile1_id: p1, profile2_id: p2 })
      .select().single()

    if (error || !conv2) return

    console.log('[match] Conversa criada com sucesso:', conv2.id)
    await db.from('chat_waiting_queue').delete().in('profile_id', [p1, p2])
    await db.from('chat_profiles').update({ waiting: false, current_conversation_id: conv2.id }).in('id', [p1, p2])
  }, 2000)
}

async function startChat(conv, partnerId) {
  console.log('[startChat] Iniciando chat com partner:', partnerId)
  const { data: partner } = await db.from('chat_profiles').select('photo_url').eq('id', partnerId).single()
  currentConversation = { id: conv.id, partner_id: partnerId }

  document.getElementById('my-photo-img').src = myProfile.photo_url
  document.getElementById('partner-photo-img').src = partner.photo_url
  document.getElementById('partner-status-label').textContent = 'online'
  document.getElementById('partner-status-label').style.color = '#9bff9b'
  document.getElementById('chat-status').textContent = ''

  showScreen('screen-chat')
  await loadMessages(conv.id)
  subscribeToMessages(conv.id)
  watchPartner(partnerId)
  startConvPoll(conv.id)
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
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${convId}` }, payload => {
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

// ========== PARTNER STATUS ==========
function watchPartner(partnerId) {
  db.channel(`partner-${partnerId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_profiles', filter: `id=eq.${partnerId}` }, payload => {
      const online = payload.new.online
      const label = document.getElementById('partner-status-label')
      label.textContent = online ? 'online' : 'offline'
      label.style.color = online ? '#9bff9b' : '#888'
      if (!online) {
        document.getElementById('chat-status').textContent = 'Partner disconnected. Finding someone new in 5s...'
        if (autoNextTimeout) clearTimeout(autoNextTimeout)
        autoNextTimeout = setTimeout(async () => {
          if (currentConversation) await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
          if (activeChannel) activeChannel.unsubscribe()
          currentConversation = null
          isMatching = false
          document.getElementById('chat-status').textContent = ''
          enterQueue()
        }, 5000)
      } else {
        if (autoNextTimeout) clearTimeout(autoNextTimeout)
        document.getElementById('chat-status').textContent = ''
      }
    })
    .subscribe()
}

function startConvPoll(convId) {
  if (convPollInterval) clearInterval(convPollInterval)
  convPollInterval = setInterval(async () => {
    if (!currentConversation) { clearInterval(convPollInterval); return }
    const { data: conv } = await db.from('chat_conversations').select('ended_at').eq('id', convId).single()
    if (conv && conv.ended_at) {
      clearInterval(convPollInterval)
      if (activeChannel) activeChannel.unsubscribe()
      currentConversation = null
      isMatching = false
      document.getElementById('chat-status').textContent = 'Partner ended the chat. Finding someone new...'
      setTimeout(() => enterQueue(), 2000)
    }
  }, 3000)
}

// ========== NEXT ==========
async function nextChat() {
  const confirmed = await showConfirm('End this conversation and find a new partner?')
  if (!confirmed) return
  if (autoNextTimeout) clearTimeout(autoNextTimeout)
  if (currentConversation) await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
  if (activeChannel) activeChannel.unsubscribe()
  currentConversation = null
  isMatching = false
  document.getElementById('chat-status').textContent = ''
  enterQueue()
}

// ========== EXIT ==========
async function cleanup() {
  if (matchPollInterval) clearInterval(matchPollInterval)
  if (autoNextTimeout) clearTimeout(autoNextTimeout)
  if (convPollInterval) clearInterval(convPollInterval)
  if (activeChannel) { activeChannel.unsubscribe(); activeChannel = null }
  isMatching = false
  if (myProfile) {
    await db.from('chat_profiles').update({ online: false, waiting: false, current_conversation_id: null }).eq('id', myProfile.id)
    await db.from('chat_waiting_queue').delete().eq('profile_id', myProfile.id)
    if (currentConversation) await db.from('chat_conversations').update({ ended_at: new Date().toISOString() }).eq('id', currentConversation.id)
  }
  currentConversation = null
}

async function exitChat() { await cleanup(); myProfile = null; showHome() }
async function cancelWaiting() { await cleanup(); myProfile = null; showHome() }

// ========== HALL OF FAME ==========
async function loadHallOfFame() {
  showScreen('screen-hall')
  const { data: photos } = await db.from('gallery_photos').select('id, photo_url, votes').order('votes', { ascending: false })
  const grid = document.getElementById('hall-grid')
  if (!photos || photos.length === 0) { grid.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1">No photos yet.</p>'; return }

  // Busca contagem de likes e comentários
  const photoIds = photos.map(p => p.id)
  const { data: likes } = await db.from('gallery_likes').select('photo_id')
  const { data: comments } = await db.from('gallery_comments').select('photo_id').is('reply_to', null)

  const likeMap = {}
  const commentMap = {}
  ;(likes || []).forEach(l => { likeMap[l.photo_id] = (likeMap[l.photo_id] || 0) + 1 })
  ;(comments || []).forEach(c => { commentMap[c.photo_id] = (commentMap[c.photo_id] || 0) + 1 })

  grid.innerHTML = photos.map(p => `
    <div class="hall-card" onclick="openPhotoDetail(${p.id}, '${p.photo_url}')">
      <div class="hall-card-img"><img src="${p.photo_url}" loading="lazy" /></div>
      <div class="hall-card-footer">
        <span class="hall-card-likes">❤️ ${likeMap[p.id] || 0}</span>
        <span class="hall-card-comments">💬 ${commentMap[p.id] || 0}</span>
      </div>
    </div>
  `).join('')
}

async function openPhotoDetail(photoId, photoUrl) {
  currentPhotoId = photoId
  document.getElementById('detail-photo-img').src = photoUrl
  showScreen('screen-photo-detail')
  await loadPhotoDetail(photoId)
}

async function loadPhotoDetail(photoId) {
  // Likes
  const { count: likeCount } = await db.from('gallery_likes').select('*', { count: 'exact', head: true }).eq('photo_id', photoId)
  document.getElementById('detail-likes-count').textContent = likeCount || 0
  const liked = myLikedPhotos.includes(photoId)
  document.getElementById('detail-like-btn').className = `like-btn ${liked ? 'liked' : ''}`

  // Comentários
  await loadComments(photoId)
}

async function toggleLike() {
  if (!currentPhotoId) return
  const liked = myLikedPhotos.includes(currentPhotoId)
  if (liked) {
    myLikedPhotos = myLikedPhotos.filter(id => id !== currentPhotoId)
    await db.from('gallery_likes').delete().eq('photo_id', currentPhotoId)
  } else {
    myLikedPhotos.push(currentPhotoId)
    await db.from('gallery_likes').insert({ photo_id: currentPhotoId })
  }
  localStorage.setItem('liked_photos', JSON.stringify(myLikedPhotos))
  const { count } = await db.from('gallery_likes').select('*', { count: 'exact', head: true }).eq('photo_id', currentPhotoId)
  document.getElementById('detail-likes-count').textContent = count || 0
  document.getElementById('detail-like-btn').className = `like-btn ${myLikedPhotos.includes(currentPhotoId) ? 'liked' : ''}`
}

async function loadComments(photoId) {
  const { data: comments } = await db.from('gallery_comments')
    .select('*')
    .eq('photo_id', photoId)
    .is('reply_to', null)
    .order('created_at', { ascending: true })

  const list = document.getElementById('comments-list')
  if (!comments || comments.length === 0) { list.innerHTML = '<p style="color:var(--muted);font-size:0.82rem">No comments yet. Be the first!</p>'; return }

  const allCommentIds = comments.map(c => c.id)
  const { data: replies } = await db.from('gallery_comments').select('*').in('reply_to', allCommentIds).order('created_at', { ascending: true })
  const replyMap = {}
  ;(replies || []).forEach(r => { if (!replyMap[r.reply_to]) replyMap[r.reply_to] = []; replyMap[r.reply_to].push(r) })

  list.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-alias">${escapeHtml(c.alias || 'Anonymous')}</div>
      <div class="comment-text">${escapeHtml(c.content)}</div>
      <div class="comment-actions">
        <button class="comment-reply-btn" onclick="openReplyModal(${c.id}, '${escapeHtml(c.content).slice(0, 40)}...')">↩ Reply</button>
      </div>
      ${(replyMap[c.id] || []).length > 0 ? `
        <div class="comment-replies">
          ${(replyMap[c.id] || []).map(r => `
            <div class="reply-item">
              <div class="comment-alias">${escapeHtml(r.alias || 'Anonymous')}</div>
              <div class="comment-text">${escapeHtml(r.content)}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `).join('')
}

async function submitComment() {
  const input = document.getElementById('comment-input')
  const text = input.value.trim()
  if (!text || !currentPhotoId) return
  input.value = ''
  await db.from('gallery_comments').insert({ photo_id: currentPhotoId, content: text, alias: randomAlias() })
  await loadComments(currentPhotoId)
}

function openReplyModal(commentId, previewText) {
  replyTargetId = commentId
  document.getElementById('reply-to-text').textContent = `Replying to: "${previewText}"`
  document.getElementById('reply-input').value = ''
  document.getElementById('reply-modal').style.display = 'flex'
}

function closeReplyModal() {
  document.getElementById('reply-modal').style.display = 'none'
  replyTargetId = null
}

async function submitReply() {
  const input = document.getElementById('reply-input')
  const text = input.value.trim()
  if (!text || !replyTargetId || !currentPhotoId) return
  input.value = ''
  closeReplyModal()
  await db.from('gallery_comments').insert({ photo_id: currentPhotoId, content: text, alias: randomAlias(), reply_to: replyTargetId })
  await loadComments(currentPhotoId)
}

// ========== GALLERY BATTLE ==========
async function startGalleryBattle() {
  const { data: photos } = await db.from('gallery_photos').select('id, photo_url, votes')
  if (!photos || photos.length < 2) {
    alert('Not enough photos in the Hall of Fame yet!')
    return
  }
  battlePool = [...photos].sort(() => Math.random() - 0.5)
  battleSeen = []
  battleRound = 0
  battleLeft = null
  battleRight = null
  showScreen('screen-battle')
  loadBattlePair()
}

function loadBattlePair() {
  document.getElementById('battle-actions').style.display = 'none'
  document.getElementById('battle-status').textContent = ''
  document.getElementById('battle-count-left').textContent = ''
  document.getElementById('battle-count-right').textContent = ''

  const leftEl = document.getElementById('battle-left')
  const rightEl = document.getElementById('battle-right')
  leftEl.className = 'battle-frame'
  rightEl.className = 'battle-frame'
  leftEl.onclick = () => galleryVote('left')
  rightEl.onclick = () => galleryVote('right')

  // Atualiza contador de rodadas
  const roundEl = document.getElementById('battle-round')
  if (roundEl) roundEl.textContent = battleLeft ? `Round ${battleRound} / ${BATTLE_MAX_ROUNDS}` : ''

  const available = battlePool.filter(p => !battleSeen.includes(p.id))

  if (!battleLeft) {
    if (battlePool.length < 2) {
      document.getElementById('battle-status').textContent = "Not enough photos to battle yet!"
      document.getElementById('battle-actions').style.display = 'flex'
      return
    }
    battleLeft = battlePool[0]
    battleRight = battlePool[1]
    battleSeen.push(battleLeft.id, battleRight.id)
  } else {
    // Campeão após 10 rodadas
    if (battleRound >= BATTLE_MAX_ROUNDS) {
      showChampion(battleLeft)
      return
    }
    // Se acabaram os oponentes, reinicia o pool sem o campeão atual
    let pool = available.filter(p => p.id !== battleLeft.id)
    if (pool.length === 0) {
      // Reinicia seen, mantendo só o campeão como visto
      battleSeen = [battleLeft.id]
      pool = battlePool.filter(p => p.id !== battleLeft.id).sort(() => Math.random() - 0.5)
    }
    battleRight = pool[0]
    battleSeen.push(battleRight.id)
  }

  document.getElementById('battle-img-left').src = battleLeft.photo_url
  document.getElementById('battle-img-right').src = battleRight.photo_url
  if (roundEl) roundEl.textContent = `Round ${battleRound + 1} / ${BATTLE_MAX_ROUNDS}`
}

async function galleryVote(side) {
  const winner = side === 'left' ? battleLeft : battleRight
  const loser = side === 'left' ? battleRight : battleLeft
  if (!winner || !loser) return

  document.getElementById('battle-left').onclick = null
  document.getElementById('battle-right').onclick = null

  // Atualiza votos do vencedor e derrota do perdedor
  await db.from('gallery_photos').update({ votes: (winner.votes || 0) + 1 }).eq('id', winner.id)
  await db.from('gallery_photos').update({ losses: (loser.losses || 0) + 1 }).eq('id', loser.id)
  winner.votes = (winner.votes || 0) + 1
  loser.losses = (loser.losses || 0) + 1

  const winnerSide = side
  const loserSide = side === 'left' ? 'right' : 'left'
  document.getElementById(`battle-${winnerSide}`).classList.add('winner')
  document.getElementById(`battle-${loserSide}`).classList.add('loser')
  document.getElementById(`battle-count-${winnerSide}`).textContent = `❤️ ${winner.votes} votes`
  document.getElementById(`battle-count-${loserSide}`).textContent = `💀 ${loser.votes || 0} votes`

  // Vencedor fica na esquerda, perdedor sai
  battleLeft = winner
  battleRight = null

  battleRound++
  // Próxima rodada automaticamente após 1.5s
  setTimeout(() => {
    battleRight = null
    loadBattlePair()
  }, 1500)
}

function nextBattleRound() {
  battleRight = null
  loadBattlePair()
}

async function showChampion(photo) {
  // Busca valor atual do banco antes de incrementar
  const { data: fresh } = await db.from('gallery_photos')
    .select('championships')
    .eq('id', photo.id)
    .single()
  
  const current = (fresh && fresh.championships) || 0
  const { error } = await db.from('gallery_photos')
    .update({ championships: current + 1 })
    .eq('id', photo.id)
  
  if (error) {
    console.error('Championship update error:', error)
  } else {
    console.log('Championship registered! New total:', current + 1)
  }
  photo.championships = current + 1

  document.getElementById('champion-img').src = photo.photo_url
  document.getElementById('champion-votes').textContent = photo.votes || 0
  showScreen('screen-champion')
}


// ========== GALLERY UPLOAD (visitante anônimo) ==========
let galleryUploadReturnScreen = 'screen-home'

function showGalleryUpload(returnScreen) {
  galleryUploadReturnScreen = returnScreen || 'screen-home'
  document.getElementById('gallery-upload-back').onclick = () => showScreen(galleryUploadReturnScreen)
  document.getElementById('gallery-file-input').value = ''
  document.getElementById('gallery-preview-img').style.display = 'none'
  document.getElementById('gallery-upload-placeholder').style.display = 'flex'
  document.getElementById('gallery-upload-consent').checked = false
  document.getElementById('gallery-upload-status').textContent = ''
  document.getElementById('btn-gallery-send').disabled = true
  showScreen('screen-gallery-upload')
}

function previewGalleryFile(event) {
  const file = event.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = e => {
    document.getElementById('gallery-preview-img').src = e.target.result
    document.getElementById('gallery-preview-img').style.display = 'block'
    document.getElementById('gallery-upload-placeholder').style.display = 'none'
  }
  reader.readAsDataURL(file)
  updateGalleryUploadBtn()
}

function updateGalleryUploadBtn() {
  const hasFile = document.getElementById('gallery-file-input').files.length > 0
  const hasConsent = document.getElementById('gallery-upload-consent').checked
  document.getElementById('btn-gallery-send').disabled = !(hasFile && hasConsent)
}

async function uploadToGallery() {
  const file = document.getElementById('gallery-file-input').files[0]
  if (!file || !document.getElementById('gallery-upload-consent').checked) return

  const status = document.getElementById('gallery-upload-status')
  const btn = document.getElementById('btn-gallery-send')
  status.textContent = 'Uploading...'
  btn.disabled = true

  const ext = file.name.split('.').pop()
  const fileName = `gallery_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadErr } = await db.storage.from('PHOTOS').upload(fileName, file)
  if (uploadErr) { status.textContent = 'Upload failed. Try again.'; btn.disabled = false; return }

  const { data: urlData } = db.storage.from('PHOTOS').getPublicUrl(fileName)
  const photoUrl = urlData.publicUrl

  const { error: dbErr } = await db.from('gallery_photos').insert({ photo_url: photoUrl, votes: 0 })
  if (dbErr) { status.textContent = 'Error saving photo. Try again.'; btn.disabled = false; return }

  status.textContent = '✅ Photo added to the Hall of Fame!'
  setTimeout(() => {
    if (galleryUploadReturnScreen === 'screen-hall') {
      loadHallOfFame()
    } else if (galleryUploadReturnScreen === 'screen-battle') {
      startGalleryBattle()
    } else {
      showScreen(galleryUploadReturnScreen)
    }
  }, 1500)
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
  if (hash !== ADMIN_HASH) { document.getElementById('admin-login-error').textContent = 'Wrong password.'; return }
  loadAdminPanel()
}

async function loadAdminPanel() {
  showScreen('screen-admin')
  document.getElementById('admin-conversations').innerHTML = '<p class="status-msg">Loading...</p>'
  const { data: convs } = await db.from('chat_conversations')
    .select('*, p1:chat_profiles!profile1_id(photo_url, code, online), p2:chat_profiles!profile2_id(photo_url, code, online)')
    .order('started_at', { ascending: false })
    .limit(50)
  if (!convs || convs.length === 0) { document.getElementById('admin-conversations').innerHTML = '<p class="status-msg">No conversations yet.</p>'; return }
  document.getElementById('admin-conversations').innerHTML = convs.map(c => `
    <div class="admin-conv-card" onclick="loadAdminConvMessages(${c.id}, this)">
      <div class="admin-conv-header">
        <div class="admin-photos"><img src="${c.p1.photo_url}" class="admin-thumb" /><span class="admin-code">#${c.p1.code}</span><span class="admin-online ${c.p1.online ? 'on' : ''}"></span></div>
        <span class="vs-small">💬</span>
        <div class="admin-photos"><img src="${c.p2.photo_url}" class="admin-thumb" /><span class="admin-code">#${c.p2.code}</span><span class="admin-online ${c.p2.online ? 'on' : ''}"></span></div>
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
  msgDiv.innerHTML = '<p class="status-msg">Loading...</p>'
  const { data: msgs } = await db.from('chat_messages').select('content, created_at, sender_id').eq('conversation_id', convId).order('created_at', { ascending: true })
  if (!msgs || msgs.length === 0) { msgDiv.innerHTML = '<p class="status-msg">No messages.</p>'; return }
  msgDiv.innerHTML = msgs.map(m => `<div class="admin-msg"><small>${new Date(m.created_at).toLocaleTimeString()}</small><span>${escapeHtml(m.content)}</span></div>`).join('')
}

// ========== ONLINE COUNT ==========
async function refreshOnlineCount() {
  const { count } = await db.from('chat_profiles').select('*', { count: 'exact', head: true }).eq('online', true)
  const el = document.getElementById('online-count')
  if (el) el.textContent = `${count || 0} online now`
}

// ========== HELPERS ==========
function escapeHtml(str) {
  if (!str) return ''
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

async function joinHallFromStats() {
  if (!myProfile) return
  await db.from('chat_profiles').update({ gallery_consent: true }).eq('id', myProfile.id)
  const { data: existing } = await db.from('gallery_photos').select('id').eq('profile_id', myProfile.id).maybeSingle()
  if (!existing) {
    await db.from('gallery_photos').insert({ profile_id: myProfile.id, photo_url: myProfile.photo_url })
  }
  await loadProfileStats(myProfile)
}
