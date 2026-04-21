## WhatsApp Verification (Evolution API)

Projeto simples para **confirmar contas via WhatsApp** usando a **Evolution API**.

### Como funciona (visão geral)

1. O utilizador cria conta na Comunidade e recebe um **código** (ex.: `99999`)
2. O frontend abre um link para WhatsApp com mensagem pré-definida:
   - `Gostaria de confirmar meu acesso a comunidade RPM com o codigo: 99999`
3. A Evolution API recebe a mensagem e envia um webhook `MESSAGES_UPSERT` para este serviço.
4. Este serviço valida a mensagem, extrai o código e chama a API do backend da Comunidade para **confirmar a conta** e gravar o WhatsApp que enviou o código.

### Componentes...

- **Evolution API**: container `atendai/evolution-api`
- **Webhook receiver**: `app/` (Node/Express)

### Variáveis importantes (.env na VPS)

- `EVOLUTION_API_KEY`: chave para usar a Evolution
- `EVOLUTION_INSTANCE`: instância principal (ex.: `comunidade`)
- `EVOLUTION_INSTANCE_SECONDARY`: instância secundária (opcional, ex.: `comunidade-2`)
- `EVOLUTION_CHATBOT_INSTANCES`: lista CSV de instâncias permitidas para o chatbot (ex.: `comunidade,comunidade-2`). Se vazio, usa principal + secundária.
- `EVOLUTION_FAILOVER_ENABLED`: `1` (padrão) para tentar envio automático na instância reserva quando a principal falhar.
- `WEBHOOK_PUBLIC_URL`: URL pública do receiver (ex.: `https://wa-verify.seudominio.com/webhook/evolution`)
- `COMMUNITY_API_URL`: URL do backend da Comunidade (ex.: `https://api-comunidade...`)
- `COMMUNITY_INTERNAL_SECRET`: segredo para autenticar chamadas internas
- `WEBHOOK_SECRET`: segredo para validar chamadas do webhook (o header HTTP tem de ser **exactamente** este valor)
- `WHATSAPP_INBOUND_DEBOUNCE_MS` (opcional): milissegundos de espera **só enquanto o texto acumulado ainda não contém um código de verificação completo** (default **10000**). Assim que o texto (numa ou várias mensagens) permitir extrair o código, a confirmação no backend corre **de imediato**, sem esperar esta janela.
- `LOG_WEBHOOK=1`: regista no stdout o `event` e as chaves de `data` (útil se a ativação não disparar — confirma se o Evolution envia `messages.upsert` e texto extraído).

### A conta não ativa após enviar o WhatsApp

1. Se a mensagem já inclui o código completo, a confirmação deve ser **quase imediata**. Só há espera (debounce, 10 s por defeito) quando o texto ainda **não** forma um código reconhecível — por exemplo, texto partido em várias mensagens que só juntos completam o padrão.
2. No servidor do `wa-verify`, ver logs: deve aparecer `[wa-verify] buffer` ao receber texto e `[wa-verify] flush` / `conta confirmada` após o silêncio.
3. Se só aparecer `ignored: true`, o payload da Evolution pode não bater com o extrator: ativa `LOG_WEBHOOK=1` e confere a estrutura; confirma também `COMMUNITY_API_URL` e `COMMUNITY_INTERNAL_SECRET` iguais ao backend.
4. Confirma que o webhook da Evolution aponta para o path correto (ex. `/webhook/evolution`) e que o Nginx injeta `x-webhook-secret` se usares `WEBHOOK_SECRET`.

### Webhook, Nginx e header `x-webhook-secret`

O receiver compara o header **`x-webhook-secret`** com **`WEBHOOK_SECRET`** do ambiente. A Evolution normalmente **não** envia esse header.

Em produção, o Nginx em `wa-verify` deve fazer **`proxy_set_header x-webhook-secret "<mesmo valor que WEBHOOK_SECRET>";`** no `location` que faz `proxy_pass` para o receiver. Assim os pedidos HTTPS funcionam **sem** colocares o segredo à mão no `curl`.

Se a Evolution logar **`413`** / **`Payload Too Large`**, o corpo do webhook excede o limite. No **mesmo** `server` ou `location /` do `wa-verify`, adiciona:

```nginx
client_max_body_size 25M;
```

(Valor alinhado com o limite JSON do `server.js`, `25mb`.)

**Não uses** texto placeholder tipo `SEU_WEBHOOK_SECRET_DO_ENV` no header: isso **não** é o valor real e resulta em **403 Forbidden**.

### Testar o receiver na VPS

**Pelo domínio (igual à Evolution; Nginx injeta o segredo):**

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/connection-update" \
  -H 'content-type: application/json' \
  --data '{}'
```

**Direto à porta local** (sem Nginx): tens de passar o segredo **real** vindo do `.env`:

```bash
cd /opt/wa-verify
set -a && . ./.env && set +a

curl -i -X POST "http://127.0.0.1:13100/webhook/evolution/connection-update" \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  --data '{}'
```

Para simular uma mensagem com código (deve bater com o texto que o registo envia ao WhatsApp):

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/messages-upsert" \
  -H 'content-type: application/json' \
  --data '{"data":{"key":{"remoteJid":"351999999999@s.whatsapp.net"},"message":{"conversation":"codigo: 12345"}}}'
```

### Deploy na VPS (resumo)

Criar `/opt/wa-verify/.env` e, na pasta do projeto (com `docker-compose.yml` na **raiz** — é o ficheiro padrão do `docker compose`):

```bash
cd /opt/wa-verify
docker compose pull
docker compose up -d
```

**Qual ficheiro Compose usar**

| Situação | Comando |
|----------|---------|
| Repositório completo com `docker-compose.yml` na raiz (recomendado) | `docker compose ps` / `docker compose logs -f receiver` |
| Só existe `deploy/docker-compose.vps.yml` (clone antigo ou path diferente) | `docker compose -f deploy/docker-compose.vps.yml ps` (a partir da **raiz** do repo) |
| Erro `open .../deploy/docker-compose.vps.yml: no such file or directory` | Na VPS não há pasta `deploy/`. Usa o `docker-compose.yml` na raiz: `ls -la /opt/wa-verify/*.yml` e `docker compose` **sem** `-f deploy/...` |

Os dois ficheiros no repositório descrevem os mesmos serviços; o da raiz usa `build.context: ./app`, o de `deploy/` usa `../app` porque o ficheiro está dentro de `deploy/`.

