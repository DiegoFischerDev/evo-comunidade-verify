## WhatsApp Verification (Evolution API)

Projeto simples para **confirmar contas via WhatsApp** usando a **Evolution API**.

### Como funciona (visão geral)

1. O utilizador cria conta na Comunidade e recebe um **código** (ex.: `99999`)
2. O frontend abre um link para WhatsApp com mensagem pré-definida:
   - `Gostaria de confirmar meu acesso a comunidade RPM com o codigo: 99999`
3. A Evolution API recebe a mensagem e envia um webhook `MESSAGES_UPSERT` para este serviço.
4. Este serviço valida a mensagem, extrai o código e chama a API do backend da Comunidade para **confirmar a conta** e gravar o WhatsApp que enviou o código.

### Componentes

- **Evolution API**: container `atendai/evolution-api`
- **Webhook receiver**: `app/` (Node/Express)

### Variáveis importantes (.env na VPS)

- `EVOLUTION_API_KEY`: chave para usar a Evolution
- `EVOLUTION_INSTANCE`: nome da instância (ex.: `comunidade`)
- `WEBHOOK_PUBLIC_URL`: URL pública do receiver (ex.: `https://wa-verify.seudominio.com/webhook/evolution`)
- `COMMUNITY_API_URL`: URL do backend da Comunidade (ex.: `https://api-comunidade...`)
- `COMMUNITY_INTERNAL_SECRET`: segredo para autenticar chamadas internas
- `WEBHOOK_SECRET`: segredo para validar chamadas do webhook

### Deploy na VPS (resumo)

Usar `deploy/docker-compose.vps.yml`, criar `/opt/wa-verify/.env`, e subir:

```bash
cd /opt/wa-verify
docker compose pull
docker compose up -d
```

