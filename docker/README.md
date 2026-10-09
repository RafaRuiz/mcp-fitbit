# Despliegue en CapRover

El servidor es un **Remote MCP** multiusuario sobre la **Google Health API**
(la sucesora de la Fitbit Web API, que se apaga el 30-10-2026). Una sola app
sirve a todas las personas autorizadas: cada una añade el conector en **su**
Claude, inicia sesión con **su** cuenta de Google y solo ve **sus** datos.

```
claude.ai (web/móvil) ──HTTPS──▶ CapRover NGINX ──HTTP──▶ node build/index.js (8000)
                                                            │
   /health ─────────────────────────── (sin auth) ──────────┤ ok
   /.well-known/oauth-*, /register,                         │
   /authorize, /token, /revoke ─────── OAuth 2.1 (SDK MCP) ─┤
   /oauth/google/callback ──────────── vuelta de Google ────┤
   POST /mcp ──────────────────────── Bearer (token MCP) ───┘ Streamable HTTP sin estado
```

**Cómo funciona el login.** El servidor es su propio servidor OAuth y
delega el inicio de sesión en Google:

1. Claude se registra solo (DCR) y abre `/authorize`.
2. El servidor manda a Google, la persona inicia sesión y da su consentimiento.
3. Google vuelve a `/oauth/google/callback`.
4. El servidor comprueba que el email esté en `ALLOWED_EMAILS`, guarda el
   refresh token de Google de esa persona y devuelve a Claude un código propio.
5. Claude obtiene tokens MCP propios (1 h, con refresh). Los tokens de Google
   nunca salen del servidor.

## Pre-requisitos

1. CapRover funcionando con Let's Encrypt.
2. **Google Cloud**: un proyecto **dedicado** (el actual es `mcp-google-health`,
   ID `rafaruiz-health-mcp`), con la *Google Health API* activada. Tiene que ser
   dedicado porque la pantalla de consentimiento, los test users y el estado de
   publicación son comunes a todo el proyecto: publicarlo afectaría a cualquier
   otro conector que lo comparta.
   - **Branding**: nombre de la app, email de soporte, *Application home page*
     `https://<host>/` y *privacy policy* `https://<host>/privacy`. El servidor
     sirve las dos páginas, y Google no deja publicar sin ellas.
   - **Clients → Create client → Web application**. En **Authorized redirect
     URIs** pon `https://<host>/oauth/google/callback`. Si quieres probar en
     local, añade también `http://localhost:8000/oauth/google/callback`.
   - **Google Auth Platform → Data access → Add or remove scopes**:
     - `openid`
     - `email`
     - `.../auth/googlehealth.activity_and_fitness.readonly`
     - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
     - `.../auth/googlehealth.sleep.readonly`
     - `.../auth/googlehealth.nutrition.readonly`
     - `.../auth/googlehealth.nutrition.writeonly`
     - `.../auth/googlehealth.profile.readonly`
     - `.../auth/googlehealth.settings.readonly`

     > Si el selector no ofrece alguno (p. ej. `nutrition.readonly`), quítalo
     > también del servidor con la variable `GOOGLE_SCOPES`. Si Google recibe
     > un scope que no existe, rechaza el login entero (`invalid_scope`).
   - **Audience**: *External*. Añade a cada persona como **Test user**.
     Mientras la app esté en *Testing*, **los refresh tokens de Google caducan
     a los 7 días** y toca reconectar el conector cada semana. Para evitarlo,
     **Publish app** (*In production*, sin verificar, hasta 100 usuarios): al
     conectar saldrá el aviso de "app no verificada" y hay que pulsar
     *Continuar*. Después de publicar, reconectad para obtener tokens sin esa
     caducidad.
3. **Cada persona** tiene que haber entrado al menos una vez en la **app
   Google Health** del móvil con su cuenta de Google y haber terminado la
   migración desde Fitbit. Si no, el login se para en una página que lo explica.

## Pasos en CapRover

### 1. Crear la app

1. **Apps → Create New App**, por ejemplo `mcp-health`.
2. Marca **"Has Persistent Data"** antes de crearla; después no se puede activar.

### 2. Deploy desde GitHub

1. **App Configs → Deployment → Deploy from Github/Bitbucket/Gitlab**.
2. Repo: `https://github.com/<tu-usuario>/mcp-fitbit`. Rama: la que despliegues
   (`deploy`).
3. Si quieres auto-deploy, pega el webhook en GitHub. Si no, usa **Force Build**.

### 3. Variables de entorno

**App Configs → Environmental Variables**:

```
GOOGLE_CLIENT_ID=<client id del OAuth client Web>
GOOGLE_CLIENT_SECRET=<client secret>
PUBLIC_BASE_URL=https://<host>
ALLOWED_EMAILS=tu@gmail.com,ella@gmail.com
```

`PUBLIC_BASE_URL` tiene que ser la URL pública **https** exacta: se usa como
issuer OAuth, para el `resource` del MCP (`${PUBLIC_BASE_URL}/mcp`) y para el
redirect de Google.

### 4. Volumen persistente

**App Configs → Persistent Directories**:

| Path in App | Label             |
| ----------- | ----------------- |
| `/data`     | `mcp-health-data` |

Ahí vive `store.json` (modo 600), con los clientes registrados, los refresh
tokens MCP (hasheados) y los tokens de Google de cada persona. Sin volumen,
cada redeploy obliga a reconectar.

### 5. HTTP

**App Configs → HTTP Settings**: activa **Enable HTTPS** y **Force HTTPS**.
Container HTTP Port: `8000`.

No hace falta ninguna configuración especial de NGINX: el endpoint `/mcp`
responde JSON normal, sin streams SSE largos.

### 6. Una sola réplica

**Instance Count = 1**. Los códigos de autorización y los access tokens MCP
viven en memoria del proceso. Tras un reinicio, Claude refresca solo con su
refresh token, que está persistido.

### 7. Conectar en claude.ai (cada persona en su cuenta)

1. Si tenías el conector antiguo (`.../sse` con Bearer), **elimínalo**.
2. **Settings → Connectors → Add custom connector**.
3. **URL**: `https://<host>/mcp`. Deja vacíos el client ID y el secret de
   *Advanced settings*: Claude se registra solo.
4. **Connect**, inicia sesión con **tu** cuenta de Google y acepta los permisos.
   Marca todas las casillas: si desmarcas alguna, esas herramientas darán 403.
5. En el móvil aparece solo.

> Si los dos conectáis desde el mismo navegador, cuidado con arrastrar la
> sesión de Google de la otra persona. Usa una ventana de incógnito o el
> selector de cuentas de Google.

## Operativa

- **Tokens**: el servidor refresca los de Google cuando hace falta y Claude
  refresca los suyos cada hora. No hay que tocar nada.
- **"Reconnect the connector"** en una respuesta significa que Google revocó o
  caducó la autorización (por ejemplo, app en *Testing* tras 7 días).
  Soluciónalo en Claude → Connectors → reconectar.
- **Añadir a alguien**: añádelo a `ALLOWED_EMAILS` y como test user en Google,
  y que añada el conector en su Claude.
- **Actualizar código**: push a la rama desplegada y **Force Build** (o webhook).

## Variables de entorno: referencia

| Variable                        | Default        | Notas                                                                 |
| ------------------------------- | -------------- | --------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`              | (requerido)    | OAuth client tipo Web de Google Cloud.                                |
| `GOOGLE_CLIENT_SECRET`          | (requerido)    |                                                                       |
| `PUBLIC_BASE_URL`               | (requerido)    | URL pública https, sin `/` final.                                     |
| `ALLOWED_EMAILS`                | (requerido)    | Emails de Google autorizados, separados por comas.                    |
| `DATA_DIR`                      | `/data`        | Dónde se guarda `store.json`.                                         |
| `PORT`                          | `8000`         |                                                                       |
| `TRUST_PROXY`                   | `1`            | Saltos de proxy delante (NGINX de CapRover = 1; con Cloudflare, 2).   |
| `GOOGLE_SCOPES`                 | (ver config)   | Lista de scopes separada por espacios, para quitar o añadir alguno.   |
| `MCP_ACCESS_TOKEN_TTL_SECONDS`  | `3600`         | Vida de los access tokens MCP.                                        |
| `MCP_REFRESH_TOKEN_TTL_SECONDS` | `7776000`      | 90 días; se renueva en cada refresh.                                  |

## Troubleshooting

| Síntoma                                                     | Causa probable                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude: "couldn't connect" al añadir el conector            | `PUBLIC_BASE_URL` incorrecta, o falta HTTPS. Comprueba que `/.well-known/oauth-authorization-server` devuelve un `issuer` https. |
| Google: `redirect_uri_mismatch`                             | Falta `${PUBLIC_BASE_URL}/oauth/google/callback` en el OAuth client de Google.                    |
| Google: `invalid_scope` / "Some requested scopes were invalid" | Un scope no está disponible: ajusta `GOOGLE_SCOPES` y la pantalla *Data access*.                |
| Google: "access blocked / app not verified" sin opción de seguir | La cuenta no está como test user (app en *Testing*).                                          |
| Vuelve a Claude con `access_denied`                         | El email no está en `ALLOWED_EMAILS`.                                                             |
| Página "Google Health account not set up"                   | Entrar en la app Google Health del móvil y completar la migración.                                |
| Herramientas: 403 `PERMISSION_DENIED`                       | Se desmarcó algún permiso al conectar, o el registro lo creó otra app (no se puede borrar/editar). |
| Hay que reconectar cada semana                              | App de Google en *Testing*: publícala (paso 2 de pre-requisitos).                                 |
| Logs: `rate limit` / 429 en `/token` o `/authorize`         | `TRUST_PROXY` mal ajustado: todas las peticiones parecen venir de la misma IP.                    |
