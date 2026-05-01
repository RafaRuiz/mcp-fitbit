# Despliegue en CapRover (rama `deploy`)

Esta rama añade lo necesario para correr `mcp-fitbit` como **Remote MCP**
detrás de Bearer auth, encima de [supergateway](https://github.com/supercorp-ai/supergateway)
(que convierte el transporte stdio del MCP en SSE). La rama `main` se mantiene
limpia para la PR upstream de las nuevas tools de nutrición.

```
claude.ai (web/móvil) ──HTTPS──▶ CapRover NGINX ──HTTP──▶ auth-proxy (8000)
                                                              │
                                       ┌── /health ──────── (sin auth) ──▶ ok
                                       ├── /auth, /callback ─ (sin auth) ──▶ MCP OAuth (3000)
                                       └── /sse, /message ─── (Bearer)  ──▶ supergateway (8001) ──▶ MCP stdio
```

**Sin SSH ni SCP**: el usuario hace OAuth desde cualquier navegador (móvil,
portátil, lo que sea) visitando `https://tu-app.tudominio.com/auth`.

## Arquitectura para 2 personas

Una sola imagen Docker, **dos apps en CapRover** completamente aisladas:

| App                | Volumen `/data`         | Bearer secret  | Endpoint                                  | Quién lo usa            |
| ------------------ | ----------------------- | -------------- | ----------------------------------------- | ----------------------- |
| `mcp-fitbit-rafa`  | tu `.fitbit-token.json` | el tuyo        | `https://fitbit-rafa.tudominio.com/sse`   | Tu Claude (web + móvil) |
| `mcp-fitbit-paula` | el suyo                 | el suyo        | `https://fitbit-paula.tudominio.com/sse`  | El Claude de tu mujer   |

Cada Claude (el tuyo y el de ella) añade **su** Remote MCP Connector apuntando
a **su** endpoint con **su** Bearer.

## Pre-requisitos

1. CapRover funcionando con Let's Encrypt activo en el wildcard.
2. Una app de desarrollador en [dev.fitbit.com](https://dev.fitbit.com) con
   **OAuth 2.0 Application Type = Personal**, y en **Callback URL** añadidas
   las URLs públicas que vayas a usar (Fitbit acepta varias separadas por coma):
   ```
   https://fitbit-rafa.tudominio.com/callback,https://fitbit-paula.tudominio.com/callback,http://localhost:3000/callback
   ```
   Mantén la de `localhost:3000` por si quieres correrlo en local algún día.
3. Tu fork de `mcp-fitbit` en GitHub con la rama `deploy` pusheada.

> Las dos apps pueden compartir las mismas Fitbit `CLIENT_ID/SECRET` — Fitbit
> distingue usuarios por el access token, no por el client. Si prefieres
> aislar por completo, cada persona puede tener su propia Fitbit dev app.

## Pasos por instancia (repetir para cada persona)

### 1. Crear la app en CapRover

1. **Apps → Create New App** → nombre `mcp-fitbit-<persona>` (ej. `mcp-fitbit-rafa`).
2. Marcar **"Has Persistent Data"** ANTES de crear (no se puede activar después).

### 2. Configurar deploy desde GitHub

1. **App Configs → Deployment → Method 3: Deploy from Github/Bitbucket/Gitlab**.
2. Repo: `https://github.com/<tu-usuario>/mcp-fitbit`
3. Branch: `deploy`
4. Username + Personal Access Token (si el repo es privado).
5. Copia el **Webhook URL** y pégalo en GitHub → Settings → Webhooks (sólo si
   quieres auto-deploy en cada push).
6. **"Force Build"** para arrancar la primera build manualmente.

### 3. Variables de entorno

**App Configs → Environmental Variables**:

```
FITBIT_CLIENT_ID=<tu Fitbit dev client id>
FITBIT_CLIENT_SECRET=<tu Fitbit dev client secret>
MCP_BEARER_TOKEN=<openssl rand -hex 32>
OAUTH_REDIRECT_URI=https://fitbit-<persona>.tudominio.com/callback
```

> El `OAUTH_REDIRECT_URI` debe coincidir EXACTAMENTE con una de las callback
> URLs registradas en tu Fitbit dev app.

### 4. Volumen persistente

**App Configs → Persistent Directories** → Add:

| Path in App | Label                       |
| ----------- | --------------------------- |
| `/data`     | `mcp-fitbit-<persona>-data` |

Sin esto, el `.fitbit-token.json` se pierde en cada redeploy.

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

    # SSE: streams sin buffer ni cache.
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
refrescar el access token a la vez y perder rotaciones del refresh token. Para
uso personal, una réplica sobra.

### 7. OAuth — desde cualquier navegador

Una vez deployada la app y verde el `/health`:

1. La persona (en su móvil o portátil, donde sea) abre:
   ```
   https://fitbit-<persona>.tudominio.com/auth
   ```
2. Redirige a Fitbit. **Logear con la cuenta de Fitbit que toca** (cuidado si
   compartís navegador — cerrar sesión de Fitbit primero si hace falta).
3. Pantalla de consent: en cada categoría que aparezca (Nutrition, Activity,
   Sleep, Weight, Heart Rate), seleccionar **"View and Log"** (NO "View
   only"), si no las tools de write devolverán 403.
4. Redirige a `https://fitbit-<persona>.tudominio.com/callback?code=...`.
5. Mensaje "Authorization successful! You can close this window."
6. El `.fitbit-token.json` queda guardado en el volumen `/data` de la app.

Repetir lo mismo para la otra persona en su URL.

> **Heads-up sobre sesiones de navegador**: si los dos vais a OAuth en el
> mismo navegador (mismo equipo, misma cuenta de macOS), podéis arrastrar la
> sesión de Fitbit del primer flow al segundo y autorizar con la cuenta
> equivocada. Para evitarlo: pestaña incógnito para el segundo flow, o cerrar
> sesión de fitbit.com entre uno y otro.

### 8. Añadir el Remote MCP Connector en claude.ai

claude.ai → **Settings → Connectors → Add custom connector**:

- **URL**: `https://fitbit-<persona>.tudominio.com/sse`
- **Authentication**: `Bearer <MCP_BEARER_TOKEN>` (el del paso 3)

Tu mujer hace lo mismo en SU cuenta de Claude con SU URL y SU bearer. El móvil
ya lo ve automáticamente.

## Operativa diaria

- **Token refresh**: el container lo hace solo (refresh tokens duran meses).
  No hay que tocar nada.
- **Cuando algo se rompa** (refresh token caducó, scopes cambian, lo que sea):
  visitar `/auth` desde cualquier navegador y rehacer el OAuth. Sin SSH.
- **Actualizar código** (nuevas tools, fixes en `main`):
  ```bash
  git checkout deploy
  git merge main
  git push origin deploy
  ```
  CapRover detecta el push y rebuilds (si tienes el webhook). Si no, **Force
  Build** desde la UI.

## Variables de entorno: referencia completa

| Variable               | Default                          | Notas                                                                                              |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `FITBIT_CLIENT_ID`     | (requerido)                      | De tu Fitbit dev app.                                                                              |
| `FITBIT_CLIENT_SECRET` | (requerido)                      | De tu Fitbit dev app.                                                                              |
| `MCP_BEARER_TOKEN`     | (requerido)                      | Secret que claude.ai manda en `Authorization: Bearer ...`. Genera con `openssl rand -hex 32`.      |
| `OAUTH_REDIRECT_URI`   | `http://localhost:3000/callback` | URL pública del callback. Debe coincidir con una registrada en tu Fitbit dev app.                  |
| `OAUTH_PORT`           | `3000`                           | Puerto interno donde escucha el OAuth express server. No suele hacer falta cambiarlo.              |
| `OAUTH_PERSISTENT`     | `true` (lo pone `entrypoint.sh`) | Si `true`, el OAuth server queda vivo entre flows para permitir re-auth.                           |
| `PORT`                 | `8000`                           | Puerto del auth-proxy. CapRover suele detectarlo solo.                                             |
| `SUPERGATEWAY_PORT`    | `8001`                           | Puerto interno de supergateway. No suele hacer falta cambiarlo.                                    |

## Troubleshooting

| Síntoma                                         | Causa probable                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `/health` devuelve 200 pero `/sse` cuelga        | NGINX sin `proxy_buffering off` (paso 5).                                   |
| `/auth` devuelve 502 "OAuth server unavailable"  | El proceso MCP no arranca el OAuth express server. Logs + `OAUTH_PERSISTENT=true`. |
| `401 unauthorized` en claude.ai                  | Bearer mal copiado.                                                         |
| Logs: `MCP_BEARER_TOKEN must be set`             | Falta la env var (paso 3).                                                  |
| `redirect_uri_mismatch` al hacer OAuth           | `OAUTH_REDIRECT_URI` no coincide con lo registrado en Fitbit dev app.       |
| Tools de write devuelven 403                     | OAuth concedió `r*` solo, no `w*`. Re-OAuth marcando **"View and Log"**.    |
| Container reinicia en bucle                      | `docker logs` desde el host. Verifica `MCP_COMMAND` y que `build/index.js` exista. |
| Cross-token: tu mujer logea en tu Fitbit         | Sesión de navegador compartida durante OAuth. Re-OAuth en pestaña incógnito.|
