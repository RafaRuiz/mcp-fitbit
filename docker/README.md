# Despliegue en CapRover (rama `deploy`)

Esta rama añade los archivos necesarios para correr `mcp-fitbit` como Remote MCP
detrás de Bearer auth, encima de [supergateway](https://github.com/supercorp-ai/supergateway)
(que convierte el transporte stdio del MCP en SSE). La rama `main` se mantiene
limpia para la PR upstream.

```
claude.ai (web/móvil) ──HTTPS──▶ CapRover NGINX ──HTTP──▶ auth-proxy (8000)
                                                              │
                                                              ▼ proxy_pass
                                                       supergateway (8001)
                                                              │
                                                              ▼ stdio
                                                       node build/index.js
```

## Arquitectura para 2 personas

Una sola imagen Docker, **dos apps en CapRover** completamente aisladas:

| App                    | Volumen `/data`       | Bearer secret    | Endpoint público                          |
| ---------------------- | --------------------- | ---------------- | ----------------------------------------- |
| `mcp-fitbit-rafa`      | tu `.fitbit-token.json`| el tuyo          | `https://fitbit-rafa.tudominio.com/sse`   |
| `mcp-fitbit-paula`     | el suyo               | el suyo          | `https://fitbit-paula.tudominio.com/sse`  |

Cada Claude (el tuyo y el de tu mujer) añade **su** Remote MCP Connector
apuntando a **su** endpoint con **su** Bearer.

## Pre-requisitos

1. CapRover instalado y funcionando con Let's Encrypt activo en el wildcard.
2. Una app de desarrollador en [dev.fitbit.com](https://dev.fitbit.com) con
   `Callback URL = http://localhost:3000/callback` (esto es porque el OAuth
   inicial lo haces en local — no necesitas registrar una URL pública).
3. Tu fork de `mcp-fitbit` en GitHub con la rama `deploy` pusheada.

## Pasos por instancia (repetir para cada persona)

### 1. Crear la app en CapRover

1. **Apps → Create New App** → nombre `mcp-fitbit-<persona>` (ej. `mcp-fitbit-rafa`).
2. Marcar **"Has Persistent Data"** ANTES de crear (no se puede activar después).

### 2. Configurar el deploy desde GitHub

1. **App Configs → Deployment** → **Method 3: Deploy from Github/Bitbucket/Gitlab**.
2. Repo: `https://github.com/<tu-usuario>/mcp-fitbit`
3. Branch: `deploy`
4. Username + Personal Access Token (si el repo es privado).
5. Copia el **Webhook URL** que CapRover te da y pégalo en GitHub →
   Settings → Webhooks (sólo si quieres auto-deploy en cada push).
6. **"Force Build"** para arrancar la primera build manualmente.

### 3. Variables de entorno

**App Configs → Environmental Variables** (cada app las suyas):

```
FITBIT_CLIENT_ID=<tu Fitbit dev client id>
FITBIT_CLIENT_SECRET=<tu Fitbit dev client secret>
MCP_BEARER_TOKEN=<genera con: openssl rand -hex 32>
```

> El mismo `FITBIT_CLIENT_ID/SECRET` puede usarse para las dos apps — Fitbit
> distingue usuarios por el access token, no por el client. Lo que tiene que
> ser distinto entre apps es el `MCP_BEARER_TOKEN` (cada uno el suyo).

### 4. Volumen persistente

**App Configs → Persistent Directories** → Add:

| Path in App | Label                    |
| ----------- | ------------------------ |
| `/data`     | `mcp-fitbit-<persona>-data` |

Sin esto, el `.fitbit-token.json` se pierde en cada redeploy y hay que rehacer
OAuth.

### 5. NGINX: imprescindible para SSE

**App Configs → HTTP Settings** → activar:

- ✅ **Enable HTTPS**
- ✅ **Force HTTPS by redirecting all HTTP traffic to HTTPS**
- ✅ **Websocket Support**

Y en **Custom Nginx Config**, sustituir el bloque `location /` por:

```nginx
location / {
    proxy_pass http://$$cap_appname$$:$$cap_application_port$$;
    proxy_http_version 1.1;

    # SSE necesita streams sin buffer ni cache.
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header X-Accel-Buffering no;

    # Conexión larga (sesión MCP).
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Websocket / SSE upgrade headers.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

Sin `proxy_buffering off`, NGINX retiene los chunks SSE hasta llenar el buffer
y claude.ai parece colgarse.

### 6. Una réplica, no más

**App Configs → Instance Count** = `1`. Si subes a 2+, dos containers podrían
refrescar el access token a la vez y perder la rotación del refresh token de
Fitbit. Para uso personal, una réplica sobra.

### 7. OAuth inicial — desde tu Mac

⚠️ **Cuidado con la sesión del navegador.** Si tu mujer y tú vais a OAuth en el
mismo Mac, el navegador puede tener una sesión de Fitbit activa y reusarla
silenciosamente. Para cada flow:

1. **Cerrar sesión en fitbit.com** en el navegador.
2. Borrar el token local: `rm /Users/<tu>/SourceTree/Miscellany/mcp-fitbit/.fitbit-token.json`
3. Reiniciar Claude Desktop completamente (⌘Q + matar procesos en Activity Monitor).
4. Pedirle a Claude algo que toque Fitbit (ej. *"get my Fitbit profile"*).
5. El navegador abre el consent screen de Fitbit. Logear con la cuenta correcta
   y marcar **"View and Log"** en cada categoría (no "View only").
6. El token aparece en `/Users/<tu>/SourceTree/Miscellany/mcp-fitbit/.fitbit-token.json`.

### 8. Subir el token al volumen de CapRover

SSH al host de CapRover y copiar el archivo al directorio del volumen:

```bash
# Desde tu Mac, primero copia el token al servidor:
scp /Users/<tu>/SourceTree/Miscellany/mcp-fitbit/.fitbit-token.json \
    root@<tu-caprover-host>:/tmp/fitbit-token-rafa.json

# Luego, en el servidor, mueve al volumen correcto:
ssh root@<tu-caprover-host>
mv /tmp/fitbit-token-rafa.json \
   /captain/data/srv-captain--mcp-fitbit-rafa-data/.fitbit-token.json
chown 1000:1000 /captain/data/srv-captain--mcp-fitbit-rafa-data/.fitbit-token.json
```

Ajusta el path del volumen al label exacto que pusiste en el paso 4 (CapRover
le añade el prefijo `srv-captain--`).

### 9. Reiniciar el container

CapRover → la app → **Deploy** → **"Restart App"**. Confirma en los logs:

```
[entrypoint] (no warning sobre token missing)
auth-proxy listening on :8000 → supergateway :8001
```

Health check: `curl https://fitbit-rafa.tudominio.com/health` → `ok`.

### 10. Añadir el Remote MCP Connector en claude.ai

claude.ai → **Settings → Connectors → Add custom connector**:

- **URL**: `https://fitbit-rafa.tudominio.com/sse`
- **Authentication**: `Bearer <MCP_BEARER_TOKEN>` (el que generaste en el paso 3)

Cuando tu mujer añada el suyo, lo hace desde **su** cuenta de Claude, con la
URL y bearer de **su** app. Claude.ai lo verá automáticamente desde su móvil.

## Después de hacer todo eso, repetir desde el paso 1 para la segunda persona.

## Operativa diaria

- **Token refresh**: el container lo hace solo. No hay que tocar nada hasta
  que el refresh token caduque (Fitbit los rota — pueden durar meses).
- **Cuando caduque**: rehacer pasos 7–9 para esa persona. Avisará con un 401
  en los logs.
- **Actualizar código** (nuevas tools en la rama `main`):

  ```bash
  git checkout deploy
  git merge main
  git push origin deploy
  ```

  CapRover detecta el push y rebuilds (si tienes el webhook). Si no, **Force
  Build** desde la UI.

## Troubleshooting

| Síntoma                                     | Causa probable                                              |
| ------------------------------------------- | ----------------------------------------------------------- |
| `/health` devuelve 200 pero `/sse` cuelga   | NGINX no está con `proxy_buffering off` (ver paso 5).       |
| `401 unauthorized` en claude.ai             | Bearer mal copiado — sin el prefijo `Bearer ` o con espacios.|
| Logs: `MCP_BEARER_TOKEN must be set`        | Falta la env var. Paso 3.                                   |
| Logs: `[entrypoint] /data/... not found`    | No has subido el `.fitbit-token.json` al volumen. Paso 8.   |
| Las tools de write devuelven 403            | El token tiene scopes `r*` solamente. OAuth de nuevo y marca **"View and Log"** (no "View only").|
| Container se reinicia en bucle              | `docker logs` desde el host — probablemente supergateway no arranca. Verifica `MCP_COMMAND` y que `build/index.js` exista en la imagen.|
