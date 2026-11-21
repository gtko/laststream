package com.laststream.app.downloads

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest

/** Espace occupé par les téléchargements et espace libre de l'appareil, en octets. */
data class StorageUsage(val used: Long, val available: Long)

/**
 * Magasin des fichiers téléchargés : un dossier privé de l'application (aucune permission de stockage).
 * Le nom d'un fichier est l'empreinte SHA-256 de l'identifiant : jamais d'identifiant (ni de nom venu du serveur) dans un chemin.
 * `<hash>.part` pendant le téléchargement, `<hash>.bin` une fois finalisé. JVM pur : testé sans appareil.
 */
class DownloadFiles(root: File) {
    private val root: File = root.canonicalFile

    init { this.root.mkdirs() }

    companion object {
        /** SHA-256 hexadécimal minuscule de l'identifiant (UTF-8). */
        fun hash(id: String): String =
            MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun part(id: String) = File(root, hash(id) + ".part")
    private fun bin(id: String) = File(root, hash(id) + ".bin")

    /** Taille déjà écrite : le `.part`, sinon le fichier finalisé, sinon 0. */
    @Synchronized
    fun size(id: String): Long {
        val p = part(id)
        if (p.isFile) return p.length()
        val b = bin(id)
        return if (b.isFile) b.length() else 0L
    }

    /** Écrit `bytes` à `offset` dans le `.part`. Jamais au-delà de la taille courante (pas de trou) : sinon erreur. */
    @Synchronized
    fun write(id: String, offset: Long, bytes: ByteArray) {
        val p = part(id)
        val current = if (p.isFile) p.length() else 0L
        if (offset < 0 || offset > current) throw IOException("offset")
        RandomAccessFile(p, "rw").use { raf ->
            raf.seek(offset)
            raf.write(bytes)
        }
    }

    /** Ouvre le `.part` en ajout (le moteur écrit en flux à la suite de `size(id)`). */
    @Synchronized
    fun openAppend(id: String): FileOutputStream {
        val p = part(id)
        val b = bin(id)
        // Reprise sur un fichier finalisé : il redevient un `.part` (sinon on écrirait dans un `.part` vide qui remplacerait le `.bin`).
        if (!p.isFile && b.isFile && !b.renameTo(p)) throw IOException("rename")
        return FileOutputStream(p, true)
    }

    /** Réduit le fichier à `len` octets (jamais plus grand que la taille courante). Un fichier finalisé redevient un `.part`. */
    @Synchronized
    fun truncate(id: String, len: Long) {
        val current = size(id)
        if (len < 0 || len > current) throw IOException("len")
        val p = part(id)
        if (!p.isFile) {
            val b = bin(id)
            if (!b.isFile) return // rien à tronquer : 0 octet
            if (!b.renameTo(p)) throw IOException("rename")
        }
        RandomAccessFile(p, "rw").use { it.setLength(len) }
    }

    /** Renomme `.part` en `.bin`. Idempotent : déjà finalisé = rien à faire ; ni l'un ni l'autre = erreur. */
    @Synchronized
    fun finalize(id: String) {
        val p = part(id)
        val b = bin(id)
        if (!p.isFile) {
            if (b.isFile) return
            throw IOException("absent")
        }
        if (b.isFile && !b.delete()) throw IOException("replace")
        if (!p.renameTo(b)) throw IOException("rename")
    }

    /** Supprime le `.part` et le `.bin` : libère l'espace. */
    @Synchronized
    fun remove(id: String) {
        val p = part(id)
        val b = bin(id)
        if (p.exists() && !p.delete()) throw IOException("delete")
        if (b.exists() && !b.delete()) throw IOException("delete")
    }

    /** Espace occupé (somme des fichiers du dossier) et espace libre. */
    @Synchronized
    fun usage(): StorageUsage {
        val used = root.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
        return StorageUsage(used, root.usableSpace)
    }

    /** Chemin du fichier finalisé, null s'il ne l'est pas (ou s'il sortait du dossier). */
    @Synchronized
    fun finalPath(id: String): File? {
        val b = bin(id)
        if (!b.isFile) return null
        val canonical = b.canonicalFile
        return if (canonical.path.startsWith(root.path + File.separator)) canonical else null
    }
}
