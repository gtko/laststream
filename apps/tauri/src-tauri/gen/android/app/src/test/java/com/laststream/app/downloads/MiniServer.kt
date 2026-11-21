package com.laststream.app.downloads

import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * Serveur HTTP/1.1 minimal pour les tests (java.base seulement : `com.sun.net.httpserver` n'est pas visible du compilateur
 * Kotlin d'Android). Une réponse par connexion (`Connection: close`).
 */
class MiniServer {
    class Exchange(val path: String, private val requestHeaders: Map<String, String>, private val out: OutputStream) {
        val responseHeaders = LinkedHashMap<String, String>()
        fun header(name: String): String? = requestHeaders[name.lowercase()]

        private fun head(status: Int, extra: String) {
            val sb = StringBuilder("HTTP/1.1 $status X\r\n")
            responseHeaders.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
            sb.append(extra).append("Connection: close\r\n\r\n")
            out.write(sb.toString().toByteArray())
        }

        /** Réponse avec `Content-Length`. */
        fun send(status: Int, body: ByteArray) {
            head(status, if (status == 204) "" else "Content-Length: ${body.size}\r\n")
            out.write(body)
            out.flush()
        }

        /** Annonce `length` octets, en envoie `partial` puis garde la connexion ouverte `holdMs` (lecture bloquée côté client). */
        fun sendPartialThenHold(status: Int, length: Long, partial: ByteArray, holdMs: Long) {
            head(status, "Content-Length: $length\r\n")
            out.write(partial)
            out.flush()
            Thread.sleep(holdMs)
        }

        /** Réponse sans taille annoncée (chunked). */
        fun sendChunked(status: Int, body: ByteArray, chunk: Int = 64 * 1024) {
            head(status, "Transfer-Encoding: chunked\r\n")
            var i = 0
            while (i < body.size) {
                val n = minOf(chunk, body.size - i)
                out.write("${n.toString(16)}\r\n".toByteArray())
                out.write(body, i, n)
                out.write("\r\n".toByteArray())
                i += n
            }
            out.write("0\r\n\r\n".toByteArray())
            out.flush()
        }
    }

    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val handlers = CopyOnWriteArrayList<Pair<String, (Exchange) -> Unit>>()
    @Volatile private var stopped = false
    val port: Int = socket.localPort

    init {
        thread(isDaemon = true, name = "mini-server") {
            while (!stopped) {
                val s = try { socket.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) { serve(s) }
            }
        }
    }

    fun on(prefix: String, handler: (Exchange) -> Unit) { handlers.add(prefix to handler) }

    fun stop() {
        stopped = true
        try { socket.close() } catch (_: Exception) { }
    }

    private fun serve(s: Socket) {
        s.use {
            try {
                val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                val line = input.readLine() ?: return
                val path = line.split(" ").getOrNull(1) ?: return
                val headers = HashMap<String, String>()
                while (true) {
                    val h = input.readLine() ?: break
                    if (h.isEmpty()) break
                    val i = h.indexOf(':')
                    if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
                }
                val ex = Exchange(path, headers, s.getOutputStream())
                val h = handlers.filter { path.startsWith(it.first) }.maxByOrNull { it.first.length }
                if (h == null) ex.send(404, ByteArray(0)) else h.second(ex)
            } catch (_: Exception) { }
        }
    }
}
