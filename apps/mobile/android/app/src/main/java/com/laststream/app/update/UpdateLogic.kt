package com.laststream.app.update

import java.io.InputStream
import java.security.MessageDigest

/** Logique pure de la mise à jour en un tap : contrôle de l'adresse et de l'empreinte, testée sans appareil. */
object UpdateLogic {
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    /** Empreinte SHA-256 (hexadécimal minuscule) d'un flux, lue par blocs. */
    fun sha256Hex(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun isSha256(s: String?): Boolean = s != null && SHA256.matches(s.trim().lowercase())

    /** Comparaison insensible à la casse, en temps constant. */
    fun sameHash(expected: String, actual: String): Boolean =
        MessageDigest.isEqual(expected.trim().lowercase().toByteArray(), actual.trim().lowercase().toByteArray())

    /** Seul le https est téléchargé (l'APK installe du code : pas de trafic en clair). */
    fun isDownloadUrl(url: String?): Boolean = url != null && url.startsWith("https://") && url.length > 12 && !url.contains(" ")

    /** Nom de fichier du téléchargement : borné à des caractères sûrs. */
    fun fileName(versionCode: Long): String = "laststream-$versionCode.apk"

    /** Progression en pourcentage (0-100) ; -1 si la taille est inconnue. */
    fun percent(done: Long, total: Long): Int = if (total <= 0) -1 else ((done * 100) / total).toInt().coerceIn(0, 100)

    /** Signataires connus des deux côtés et sans aucun en commun : l'APK vient d'une autre clé. Ensemble vide : inconnu, pas de blocage. */
    fun otherSigner(installed: Set<String>, apk: Set<String>): Boolean =
        installed.isNotEmpty() && apk.isNotEmpty() && installed.intersect(apk).isEmpty()
}
