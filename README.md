# ♡ NoMeSiguen

> App para ver **quién no te sigue de vuelta en Instagram**, directo en tu navegador. Sin instalaciones, sin contraseña, sin servidores — todo ocurre en tu propia sesión.

[![Código](https://img.shields.io/badge/📄_Código-pegar--en--consola.js-6366f1?style=for-the-badge)](./pegar-en-consola.js)

**Hecho por [@manuel_jassi](https://www.instagram.com/manuel_jassi)**

## 🚀 Cómo usarlo

### Paso 1 — Copia el código

👉 **[Abrir `pegar-en-consola.js`](./pegar-en-consola.js)** y presiona el botón **⧉ copiar** que GitHub muestra arriba a la derecha del archivo.

O copia el raw: **[pegar-en-consola.js (raw)](../../raw/main/pegar-en-consola.js)** → `Ctrl+A` → `Ctrl+C`

### Paso 2 — Pégalo en Instagram

1. Abre **[instagram.com](https://instagram.com)** con tu sesión iniciada
2. Presiona `F12` → pestaña **Console**
3. `Ctrl+V` → `Enter`
4. Clic en **▶ Escanear mi cuenta**

> **¿Chrome te bloquea el pegado?** La primera vez pide escribir `allow pasting`. Es una protección del navegador que ningún código puede quitar — **pero hay alternativa: el bookmarklet** 👇

## 🔖 Método alternativo: marcador (sin consola, sin pegar nada)

Si no quieres tocar la consola:

1. En tu navegador, crea un marcador/favorito nuevo (clic derecho en la barra de favoritos → "Agregar página")
2. Nombre: `NoMeSiguen`
3. En el campo URL pega esto:

```
javascript:(()=>{fetch('https://raw.githubusercontent.com/manueljassi12/no-me-siguen/main/pegar-en-consola.js').then(r=>r.text()).then(eval)})()
```

4. Ve a instagram.com y **haz clic en el marcador** — la app se lanza sola, siempre con la última versión del código.

## ✨ Funciones

- ⚡ **Resultados en tiempo real** — los usuarios aparecen mientras escanea
- 📑 **Pestañas:** No me siguen · Fans (te siguen y no les sigues) · ⏳ Solicitudes pendientes (a quién mandaste follow y no te aceptó) · Lista blanca
- 🎨 Interfaz profesional slate/índigo con animaciones sutiles
- 🔍 Búsqueda y filtros (verificados, privados, sin foto)
- ★ **Lista blanca** persistente — clic en el avatar para proteger una cuenta
- ⚠ **Cuentas sin verificar** — si el escaneo quedó incompleto, se marcan y puedes revisarlas una por una en vez de acusarlas falsamente
- 📤 Exportar a **JSON / CSV** o copiar la lista al portapapeles
- 👋 Dejar de seguir seleccionados, con pausas de seguridad automáticas
- ⏸ Pausar/reanudar el escaneo
- 🔄 Fallback automático: si Instagram no responde un endpoint, prueba otro

## 📁 Archivos del proyecto

| Archivo | Qué es |
|---|---|
| `pegar-en-consola.js` | ⭐ La app principal — se pega en la consola del navegador |
| `diagnostico.js` | Script de prueba para detectar qué endpoint funciona en tu sesión |
| `app.py` | Versión app de escritorio (Python + customtkinter) |
| `no_me_siguen.py` | Versión de terminal (Python + instagrapi) |

## ⚠️ Aviso

Esta herramienta usa la API interna de Instagram, lo cual va contra sus Términos de Servicio. Úsala con moderación y bajo tu propio riesgo — incluye pausas de seguridad, pero Instagram puede limitar tu cuenta si abusas.

---
<sub>Hecho por [@manuel_jassi](https://www.instagram.com/manuel_jassi)</sub>
