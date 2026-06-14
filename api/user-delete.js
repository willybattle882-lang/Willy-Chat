import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { code, action } = req.body
  if (!code || !action) return res.status(400).json({ error: 'code and action required' })
  if (!['remove_gallery', 'delete_all'].includes(action)) return res.status(400).json({ error: 'Invalid action' })

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  )

  // Busca perfil pelo código
  const { data: profile } = await db.from('chat_profiles').select('*').eq('code', code).maybeSingle()
  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  // Busca foto na galeria
  const { data: galleryPhoto } = await db.from('gallery_photos').select('*').eq('profile_id', profile.id).maybeSingle()

  if (action === 'remove_gallery') {
    if (!galleryPhoto) return res.status(404).json({ error: 'Photo not in gallery' })

    // Remove likes e comentários
    await db.from('gallery_likes').delete().eq('photo_id', galleryPhoto.id)
    await db.from('gallery_comments').delete().eq('photo_id', galleryPhoto.id)

    // Remove da galeria
    await db.from('gallery_photos').delete().eq('id', galleryPhoto.id)

    // Atualiza consent
    await db.from('chat_profiles').update({ gallery_consent: false }).eq('id', profile.id)

    return res.status(200).json({ success: true, action: 'remove_gallery' })
  }

  if (action === 'delete_all') {
    // Remove galeria se existir
    if (galleryPhoto) {
      await db.from('gallery_likes').delete().eq('photo_id', galleryPhoto.id)
      await db.from('gallery_comments').delete().eq('photo_id', galleryPhoto.id)
      await db.from('gallery_photos').delete().eq('id', galleryPhoto.id)

      // Remove foto do storage
      const galleryFileName = galleryPhoto.photo_url.split('/PHOTOS/')[1] || galleryPhoto.photo_url.split('/').pop()
      await db.storage.from('PHOTOS').remove([galleryFileName])
    }

    // Remove conversas e mensagens
    const { data: convs } = await db.from('chat_conversations')
      .select('id')
      .or(`profile1_id.eq.${profile.id},profile2_id.eq.${profile.id}`)

    if (convs && convs.length > 0) {
      const convIds = convs.map(c => c.id)
      await db.from('chat_messages').delete().in('conversation_id', convIds)
      await db.from('chat_conversations').delete().in('id', convIds)
    }

    // Remove da fila
    await db.from('chat_waiting_queue').delete().eq('profile_id', profile.id)

    // Remove foto do chat do storage
    const chatFileName = profile.photo_url.split('/PHOTOS/')[1] || profile.photo_url.split('/').pop()
    await db.storage.from('PHOTOS').remove([chatFileName])

    // Remove perfil
    await db.from('chat_profiles').delete().eq('id', profile.id)

    return res.status(200).json({ success: true, action: 'delete_all' })
  }
}
