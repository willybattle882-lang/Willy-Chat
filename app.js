const SUPABASE_URL = 'https://ozyligilnzuhnkkobgxc.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96eWxpZ2lsbnp1aG5ra29iZ3hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2ODkyNjMsImV4cCI6MjA5NjI2NTI2M30.H64U-LWB_arJkS_73sMVF-1myh3VhnFnyVCtFjlEDUg'
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

// Admin
let adminToken = null
let adminActiveTab = 'gallery'

// Hall of Fame
let currentPhotoId = null
let myLikedPhotos = JSON.parse(localStorage.getItem('liked_photos') || '[]')
let replyTargetId = null
let galleryPhotosList = []
let currentPhotoIndex = -1
let keyboardListenerActive = false

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
  if (id === 'screen-photo-detail') enableKeyboardNavigation()
  else disableKeyboardNavigation()
}

function enableKeyboardNavigation() {
  if (keyboardListenerActive) return
  window.addEventListener('keydown', handlePhotoDetailKeydown)
  keyboardListenerActive = true
}
function disableKeyboardNavigation() {
  if (!keyboardListenerActive) return
  window.removeEventListener('keydown', handlePhotoDetailKeydown)
  keyboardListenerActive = false
}
function handlePhotoDetailKeydown(e) {
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigatePhoto(-1) }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigatePhoto(1) }
  else if (e.key === 'Escape') { e.preventDefault(); loadHallOfFame() }
}

function showHome() { cleanup(); showScreen('screen-home'); refreshOnlineCount() }
function startUpload() { resetUploadForm(); showScreen('screen-upload') }
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
  await loadProfileStats(profile)
}

async function giveGalleryConsent() {
  if (!myProfile) return
  await db.from('chat_profiles').update({ gallery_consent: true }).eq('id', myProfile.id)
  const { data: existing } = await db.from('gallery_photos').select('id').eq('profile_id', myProfile.id).maybeSingle()
  if (!existing) {
    await db.from('gallery_photos').insert({ profile_id: myProfile.id, photo_url: myProfile.photo_url })
  }
  enterQueue()
}

// ========== PROFILE STATS ==========
async function loadProfileStats(profile) {
  document.getElementById('stats-photo').src = profile.photo_url

  const { data: galleryPhoto } = await db.from('gallery_photos')
    .select('id, votes, losses, championships')
    .eq('profile_id', profile.id)
    .maybeSingle()

  const joinBtn = document.getElementById('btn-join-hall')

  if (galleryPhoto) {
    document.getElementById('stats-wins').textContent = galleryPhoto.votes || 0
    document.getElementById('stats-losses').textContent = galleryPhoto.losses || 0
    document.getElementById('stats-champ').textContent = galleryPhoto.championships || 0
    document.getElementById('stats-gallery-note').textContent = 'Your photo is in the Hall of Fame ✅'
    if (joinBtn) joinBtn.style.display = 'none'
  } else {
    document.getElementById('stats-wins').textContent = '—'
    document.getElementById('stats-losses').textContent = '—'
    document.getElementById('stats-champ').textContent = '—'
    document.getElementById('stats-gallery-note').textContent = 'Your photo is not in the Hall of Fame yet'
    if (joinBtn) joinBtn.style.display = 'block'
  }

  showScreen('screen-profile-stats')
}

async function joinHallFromStats() {
  if (!myProfile) return
  await db.from('chat_profiles').update({ gallery_consent: true }).eq('id', myProfile.id)
  const { data: existing } = await db.from('gallery_photos').select('id').eq('profile_id', myProfile.id).maybeSingle()
  if (!existing) {
    await db.from('gallery_photos').insert({ profile_id: myProfile.id, photo_url: myProfile.photo_url })
  }
  const joinBtn = document.getElementById('btn-join-hall')
  if (joinBtn) joinBtn.style.display = 'none'
  await loadProfileStats(myProfile)
}

// ========== FILA (MATCHING CORRIGIDO) ==========
async function enterQueue() {
  if (isMatching) return
  isMatching = true
  showScreen('screen-waiting')
  if (matchPollInterval) clearInterval(matchPollInterval)

  await db.from('chat_profiles').update({ waiting: true, online: true }).eq('id', myProfile.id)
  await db.from('chat_waiting_queue').upsert({ profile_id: myProfile.id, joined_at: new Date().toISOString() })

  matchPollInterval = setInterval(async () => {
    // 1) Já existe conversa ativa?
    const { data: existingConv } = await db.from('chat_conversations')
      .select('*')
      .or(`profile1_id.eq.${myProfile.id},profile2_id.eq.${myProfile.id}`)
      .is('ended_at', null)
      .maybeSingle()
    if (existingConv) {
      clearInterval(matchPollInterval)
      const partnerId = existingConv.profile1_id === myProfile.id ? existingConv.profile2_id : existingConv.profile1_id
      await startChat(existingConv, partnerId)
      return
    }

    // 2) Buscar fila
    const { data: queue } = await db.from('chat_waiting_queue')
      .select('profile_id')
      .order('joined_at', { ascending: true })
      .limit(5)

    if (!queue || queue.length < 2) return

    // Filtra eu mesmo
    const others = queue.filter(q => q.profile_id !== myProfile.id)
    if (others.length === 0) return

    const partner = others[0]
    const partnerId = partner.profile_id

    // Verifica se o parceiro ainda está waiting e online
    const { data: partnerProfile } = await db.from('chat_profiles')
      .select('waiting, online')
      .eq('id', partnerId)
      .single()
    if (!partnerProfile || !partnerProfile.waiting || !partnerProfile.online) {
      await db.from('chat_waiting_queue').delete().eq('profile_id', partnerId)
      return
    }

    // 3) Criar conversa
    const { data: newConv, error: createError } = await db.from('chat_conversations')
      .insert({ profile1_id: myProfile.id, profile2_id: partnerId })
      .select()
      .single()

    if (createError) {
      console.error('Erro criar conversa:', createError)
      return
    }

    // 4) Limpar fila e atualizar status
    await db.from('chat_waiting_queue').delete().in('profile_id', [myProfile.id, partnerId])
    await db.from('chat_profiles').update({ waiting: false, current_conversation_id: newConv.id }).in('id', [myProfile.id, partnerId])

    clearInterval(matchPollInterval)
    await startChat(newConv, partnerId)
  }, 2000)
}

async function startChat(conv, partnerId) {
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
  galleryPhotosList = photos || []
  const grid = document.getElementById('hall-grid')

  grid.style.display = 'grid'
  grid.style.gridTemplateColumns = 'repeat(3, 1fr)'
  grid.style.gap = '12px'
  grid.style.width = '100%'
  grid.style.maxWidth = '640px'
  grid.style.margin = '0 auto'

  if (!galleryPhotosList.length) {
    grid.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1">No photos yet.</p>'
    return
  }

  const { data: likes } = await db.from('gallery_likes').select('photo_id')
  const { data: comments } = await db.from('gallery_comments').select('photo_id').is('reply_to', null)
  const likeMap = {}, commentMap = {}
  ;(likes || []).forEach(l => { likeMap[l.photo_id] = (likeMap[l.photo_id] || 0) + 1 })
  ;(comments || []).forEach(c => { commentMap[c.photo_id] = (commentMap[c.photo_id] || 0) + 1 })

  grid.innerHTML = galleryPhotosList.map((p, idx) => `
    <div style="display:flex;flex-direction:column;width:100%;min-width:0;cursor:pointer;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--surface2);" onclick="openPhotoDetail(${p.id}, '${p.photo_url}', ${idx})">
      <div style="width:100%;aspect-ratio:1/1;background:var(--surface2);display:flex;align-items:center;justify-content:center;">
        <img src="${p.photo_url}" style="width:100%;height:100%;object-fit:contain;" loading="lazy" />
      </div>
      <div style="padding:0.35rem 0.5rem;display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;">
        <span style="color:var(--accent);font-weight:600;">❤️ ${likeMap[p.id] || 0}</span>
        <span style="color:var(--muted);">💬 ${commentMap[p.id] || 0}</span>
      </div>
    </div>
  `).join('')
}

async function openPhotoDetail(photoId, photoUrl, index) {
  currentPhotoId = photoId
  currentPhotoIndex = (index !== undefined) ? index : galleryPhotosList.findIndex(p => p.id === photoId)
  document.getElementById('detail-photo-img').src = photoUrl
  showScreen('screen-photo-detail')
  await loadPhotoDetail(photoId)
  updateNavButtons()
}

function updateNavButtons() {
  const prevBtn = document.getElementById('detail-prev-btn')
  const nextBtn = document.getElementById('detail-next-btn')
  if (prevBtn && nextBtn) {
    prevBtn.style.display = currentPhotoIndex > 0 ? 'flex' : 'none'
    nextBtn.style.display = currentPhotoIndex < galleryPhotosList.length - 1 ? 'flex' : 'none'
  }
}

async function navigatePhoto(direction) {
  let newIndex = currentPhotoIndex + direction
  if (newIndex < 0 || newIndex >= galleryPhotosList.length) return
  currentPhotoIndex = newIndex
  const photo = galleryPhotosList[currentPhotoIndex]
  currentPhotoId = photo.id
  document.getElementById('detail-photo-img').src = photo.photo_url
  await loadPhotoDetail(photo.id)
  updateNavButtons()
}

async function loadPhotoDetail(photoId) {
  const { count: likeCount } = await db.from('gallery_likes').select('*', { count: 'exact', head: true }).eq('photo_id', photoId)
  document.getElementById('detail-likes-count').textContent = likeCount || 0
  const liked = myLikedPhotos.includes(photoId)
  document.getElementById('detail-like-btn').className = `like-btn ${liked ? 'liked' : ''}`
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

// ========== COMENTÁRIOS CORRIGIDOS ==========
async function loadComments(photoId) {
  const { data: comments } = await db.from('gallery_comments')
    .select('*').eq('photo_id', photoId).is('reply_to', null).order('created_at', { ascending: true })

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
  try {
    const { error } = await db.from('gallery_comments').insert({ 
      photo_id: currentPhotoId, 
      content: text, 
      alias: randomAlias() 
    })
    if (error) throw error
    await loadComments(currentPhotoId)
  } catch (err) {
    console.error('Erro ao comentar:', err)
    alert('Não foi possível adicionar o comentário. Tente novamente.')
  }
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
  try {
    await db.from('gallery_comments').insert({ 
      photo_id: currentPhotoId, 
      content: text, 
      alias: randomAlias(), 
      reply_to: replyTargetId 
    })
    await loadComments(currentPhotoId)
  } catch (err) {
    console.error('Erro ao responder:', err)
    alert('Não foi possível enviar a resposta.')
  }
}

// ========== GALLERY BATTLE ==========
async function startGalleryBattle() {
  const { data: photos } = await db.from('gallery_photos').select('id, photo_url, votes, losses')
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
    if (battleRound >= BATTLE_MAX_ROUNDS) {
      showChampion(battleLeft)
      return
    }
    let pool = available.filter(p => p.id !== battleLeft.id)
    if (pool.length === 0) {
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

  try {
    const res = await fetch('/api/gallery-vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winnerId: winner.id, loserId: loser.id })
    })
    if (!res.ok) throw new Error('Falha no voto')
  } catch (err) {
    console.error('Erro ao votar:', err)
    document.getElementById('battle-status').textContent = 'Error recording vote. Try again.'
    setTimeout(() => loadBattlePair(), 1000)
    return
  }

  // Atualiza os objetos locais
  winner.votes = (winner.votes || 0) + 1
  loser.losses = (loser.losses || 0) + 1

  const winnerSide = side
  const loserSide = side === 'left' ? 'right' : 'left'
  document.getElementById(`battle-${winnerSide}`).classList.add('winner')
  document.getElementById(`battle-${loserSide}`).classList.add('loser')
  document.getElementById(`battle-count-${winnerSide}`).textContent = `❤️ ${winner.votes} votes`
  document.getElementById(`battle-count-${loserSide}`).textContent = `💀 ${loser.losses} losses`

  battleLeft = winner
  battleRight = null
  battleRound++

  setTimeout(() => loadBattlePair(), 1500)
}

function nextBattleRound() {
  battleRight = null
  loadBattlePair()
}

async function showChampion(photo) {
  try {
    await fetch('/api/gallery-championship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoId: photo.id })
    })
    photo.championships = (photo.championships || 0) + 1
  } catch (err) { console.error(err) }
  document.getElementById('champion-img').src = photo.photo_url
  document.getElementById('champion-votes').textContent = photo.votes || 0
  showScreen('screen-champion')
}

// ========== GALLERY UPLOAD ==========
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
    if (galleryUploadReturnScreen === 'screen-hall') loadHallOfFame()
    else if (galleryUploadReturnScreen === 'screen-battle') startGalleryBattle()
    else showScreen(galleryUploadReturnScreen)
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
  if (!password) return

  const btn = document.querySelector('#screen-admin-login .btn-main')
  btn.disabled = true
  btn.textContent = 'Verifying...'

  try {
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    const data = await res.json()
    if (!res.ok) {
      document.getElementById('admin-login-error').textContent = 'Wrong password.'
      btn.disabled = false
      btn.textContent = 'Enter'
      return
    }
    adminToken = data.token
    sessionStorage.setItem('admin_token', adminToken)
    loadAdminPanel()
  } catch (e) {
    document.getElementById('admin-login-error').textContent = 'Error connecting. Try again.'
    btn.disabled = false
    btn.textContent = 'Enter'
  }
}

async function loadAdminPanel() {
  const token = adminToken || sessionStorage.getItem('admin_token')
  if (!token) { showScreen('screen-admin-login'); return }

  try {
    const verifyRes = await fetch('/api/admin-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
    if (!verifyRes.ok) throw new Error()
  } catch {
    sessionStorage.removeItem('admin_token')
    adminToken = null
    showScreen('screen-admin-login')
    return
  }

  showScreen('screen-admin')
  const container = document.getElementById('admin-conversations')

  if (!document.getElementById('admin-tabs')) {
    container.innerHTML = `
      <div id="admin-tabs" style="display:flex;gap:0.5rem;margin-bottom:1rem;">
        <button id="admin-tab-gallery" class="btn-main secondary" style="flex:1">📸 Gallery Photos</button>
        <button id="admin-tab-conv" class="btn-main secondary" style="flex:1">💬 Conversations</button>
      </div>
      <div id="admin-gallery-section"></div>
      <div id="admin-conv-section"></div>
    `
    document.getElementById('admin-tab-gallery').onclick = () => switchAdminTab('gallery')
    document.getElementById('admin-tab-conv').onclick = () => switchAdminTab('conversations')
  }
  await switchAdminTab(adminActiveTab)
}

async function switchAdminTab(tab) {
  adminActiveTab = tab
  const galleryDiv = document.getElementById('admin-gallery-section')
  const convDiv = document.getElementById('admin-conv-section')
  const btnGallery = document.getElementById('admin-tab-gallery')
  const btnConv = document.getElementById('admin-tab-conv')

  if (tab === 'gallery') {
    galleryDiv.style.display = 'block'
    convDiv.style.display = 'none'
    btnGallery.style.background = 'var(--accent)'
    btnConv.style.background = ''
    galleryDiv.innerHTML = '<p class="status-msg">Loading gallery...</p>'

    const { data: galleryPhotos } = await db.from('gallery_photos')
      .select('id, photo_url, votes, championships')
      .order('id', { ascending: false })

    if (!galleryPhotos || galleryPhotos.length === 0) {
      galleryDiv.innerHTML = '<p class="status-msg">No photos in gallery.</p>'
      return
    }
    galleryDiv.innerHTML = `
      <h3 class="admin-section-title">🏆 Gallery Photos</h3>
      <div class="admin-gallery-grid">
        ${galleryPhotos.map(p => `
          <div class="admin-gallery-card" data-id="${p.id}">
            <img src="${p.photo_url}" />
            <div class="admin-gallery-info">
              <span>❤️ ${p.votes || 0} wins</span>
              <span>🏆 ${p.championships || 0} champ</span>
            </div>
            <button class="admin-delete-btn" onclick="adminDeleteGalleryPhoto(${p.id}, '${p.photo_url}', this)">🗑️ Delete</button>
          </div>
        `).join('')}
      </div>
    `
  } else {
    galleryDiv.style.display = 'none'
    convDiv.style.display = 'block'
    btnConv.style.background = 'var(--accent)'
    btnGallery.style.background = ''
    convDiv.innerHTML = '<p class="status-msg">Loading conversations...</p>'

    const { data: convs } = await db.from('chat_conversations')
      .select('*, p1:chat_profiles!profile1_id(photo_url, code, online), p2:chat_profiles!profile2_id(photo_url, code, online)')
      .order('started_at', { ascending: false })
      .limit(50)

    if (!convs || convs.length === 0) {
      convDiv.innerHTML = '<p class="status-msg">No conversations yet.</p>'
      return
    }
    convDiv.innerHTML = convs.map(c => `
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

async function adminDeleteGalleryPhoto(id, url, btn) {
  const confirmed = await showConfirm('Delete this photo from the gallery? This cannot be undone.')
  if (!confirmed) return

  btn.disabled = true
  btn.textContent = 'Deleting...'

  const token = adminToken || sessionStorage.getItem('admin_token')
  if (!token) { btn.textContent = '❌ Not authenticated'; btn.disabled = false; return }

  try {
    const res = await fetch('/api/admin-delete-gallery', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ photoId: id, photoUrl: url })
    })
    if (!res.ok) {
      const err = await res.json()
      btn.textContent = `❌ ${err.error || 'Error'}`
      btn.disabled = false
      return
    }
    btn.closest('.admin-gallery-card').remove()
  } catch (e) {
    btn.textContent = '❌ Error'
    btn.disabled = false
  }
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
  const savedToken = sessionStorage.getItem('admin_token')
  if (savedToken) adminToken = savedToken

  showHome()
  refreshOnlineCount()
})

window.addEventListener('beforeunload', () => {
  if (myProfile) db.from('chat_profiles').update({ online: false }).eq('id', myProfile.id)
})
