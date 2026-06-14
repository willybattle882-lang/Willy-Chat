import { createClient } from '@supabase/supabase-js'

function verifyToken(token) {
  if (!token) return false
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const [prefix, timestamp] = decoded.split(':')
    if (prefix !== 'admin') return false
    const TWO_HOURS = 2 * 60 * 60 * 1000
    return Date.now() - parseInt(timestamp) <= TWO_HOURS
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers['x-admin-token']
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  )

  // Busca todas as fotos de chat (offline e sem conversa ativa)
  const { data: profiles } = await db
    .from('chat_profiles')
    .select('id, photo_url')
    .eq('online', false)

  if (!profiles || profiles.length === 0) {
    return res.status(200).json({ deleted: 0, message: 'No offline profiles found' })
  }

  // Filtra quem NÃO está na galeria
  const { data: galleryProfiles } = await db
    .from('gallery_photos')
    .select('profile_id')
    .not('profile_id', 'is', null)

  const galleryProfileIds = new Set((galleryProfiles || []).map(g => g.profile_id))
  const toDelete = profiles.filter(p => !galleryProfileIds.has(p.id))

  if (toDelete.length === 0) {
    return res.status(200).json({ deleted: 0, message: 'All offline profiles are in gallery' })
  }

  // Remove fotos do storage
  const fileNames = toDelete
    .map(p => p.photo_url?.split('/PHOTOS/')[1])
    .filter(Boolean)

  if (fileNames.length > 0) {
    await db.storage.from('PHOTOS').remove(fileNames)
  }

  // Remove conversas e mensagens
  const profileIds = toDelete.map(p => p.id)
  const { data: convs } = await db
    .from('chat_conversations')
    .select('id')
    .or(profileIds.map(id => `profile1_id.eq.${id},profile2_id.eq.${id}`).join(','))

  if (convs && convs.length > 0) {
    const convIds = convs.map(c => c.id)
    await db.from('chat_messages').delete().in('conversation_id', convIds)
    await db.from('chat_conversations').delete().in('id', convIds)
  }

  // Remove da fila e perfis
  await db.from('chat_waiting_queue').delete().in('profile_id', profileIds)
  await db.from('chat_profiles').delete().in('id', profileIds)

  return res.status(200).json({
    deleted: toDelete.length,
    message: `Deleted ${toDelete.length} offline profiles and their photos`
  })
}
