# block-creds

認証情報を含むテキストが LLM に送られる前に、`[REDACTED-xxxxxxxxxxxx]` に置き換える（またはその送信を拒否する）Claude Code の **mod** です。検出は [betterleaks](https://github.com/betterleaks/betterleaks) に任せていて、この mod は検出ルールを持ちません。

動作確認: Claude Code 2.1.312、betterleaks 1.9.0。mods は Claude Code 2.1.287 以降で使えます。

## 免責事項

- この mod は、認証情報が LLM に送られる危険を減らすためのものであり、漏えいを防ぐことを保証するものではありません。検出は betterleaks のルールに依存し、未知の形式や加工された値は見つかりません。守れない経路は[制限事項](#制限事項)を参照してください。
- 本物の認証情報を扱う作業では、この mod だけに頼らず、秘密値を作業ディレクトリに置かない、権限を絞ったトークンを使う、漏れたら失効させる、といった対策を併用してください。
- この mod の利用によって生じたいかなる損害（認証情報の漏えい、作業の中断、データの消失などを含む）についても、作者は責任を負いません。ソフトウェアは [MIT ライセンス](LICENSE.md) のとおり「現状のまま」提供され、明示・黙示を問わず一切の保証はありません。
- この mod は Anthropic および betterleaks の公式のものではなく、それらの開発元とは関係ありません。
- Claude Code の mods API は変更されることがあります。動作確認していない版では、期待どおりに動かない可能性があります。

## 何を守るか

| 経路                                                          | フックするイベント                         | redact（既定）       | block                          |
| ------------------------------------------------------------- | ------------------------------------------ | -------------------- | ------------------------------ |
| ユーザーのプロンプトと、添付のコンテキスト                    | `prompt.submit`                            | 置換して送信         | 送信を中止（drop）             |
| ツールの出力（Read、Bash、MCP、サブエージェントを含む）       | `tool.call`                                | 結果の文字列を置換   | 結果を破棄して deny            |
| `@file` や CLAUDE.md、settings フックの出力などエンジンが差し込む本文 | `prompt.attachment`                | 置換                 | その添付を落とす               |
| `!コマンド`（bash モード）の入力と出力、他の mod が足す行、ツールが結果と別に渡す行、圧縮で作られる行、settings フックのコンテキスト | `session.append`（door `command` / `note` / `tool-message` / `compaction` / `hook-context`） | 置換 | 本文を伏せ文に差し替え |
| 最初のメッセージのコンテキストブロック（`claudeMd` など）     | `prompt.context`                           | 置換                 | そのブロックを伏せ文に差し替え |
| システムプロンプトのセクション（`memory` など）               | `prompt.section`                           | 置換                 | そのセクションを落とす         |
| システムプロンプトのうち、上で検査していないセクション（他の mod が足したものなど） | `prompt.compose`     | 置換                 | そのセクションを落とす         |
| スキルの本文（`` !`cmd` `` の展開結果を含む）                 | `skill.prompt`                             | 置換                 | 本文を伏せ文に差し替え         |
| 他のエージェントや Remote Control などからの配信              | `session.receive`                          | 置換して渡す         | 受け取らない（consumed）       |
| 他のエージェントやセッションへ送るメッセージ                  | `session.send`                             | 置換して送る         | 送らない                       |
| スラッシュコマンドの引数（`/compact <指示>` など）            | `command.run`                              | 置換して実行         | 実行しない                     |
| 圧縮（compaction）への指示                                    | `session.compact`                          | 置換                 | 指示を伏せ文に差し替え         |
| settings の PostToolUse フックが差し替えたツール出力          | `classic.PostToolUse`                      | 置換                 | 差し替えを捨てる（元の結果を使う） |
| 他の mod が呼ぶモデル（`$.model.complete` / `fork` / `classify`） | `model.complete` など                  | 置換して送る         | 送らない（deny）               |

- 一度置換した値は、betterleaks が検出しなかった場所（`echo` で値だけが出力されたときなど）でも置換します（ルール名は `known`）。
- betterleaks が base64 などをデコードして見つけた値は、原文に無いため置換できません。redact モードでも block と同じ扱いにします。
- 下の層（PreToolUse フックや他の mod）がツール呼び出しを拒否したときの理由文も検査します。
- 秘密値の直後に `<` があると betterleaks は検出しません（`<SecretAccessKey>…</SecretAccessKey>`、`token=…</td>` など）。そのため、すべての経路で `<` の前と `>` の後に空白を入れた写しを検査し、置換は元のテキストに対して行います。
- Read の結果は行番号付きでモデルに渡るため、複数行の秘密鍵は行番号を挟んだ形で見つかります。行番号を外した形が結果の中にあれば、その形で置換します。

## betterleaks の使い方（ルールを勝手に変えさせない）

- betterleaks は作業ディレクトリの `.betterleaks.toml` / `.gitleaks.toml` と `.betterleaksignore` / `.gitleaksignore`、環境変数 `BETTERLEAKS_CONFIG(_TOML)` / `GITLEAKS_CONFIG(_TOML)` を読みます。プロジェクトにこれらがあると、ルールの差し替えや検出の除外ができてしまいます。この mod は betterleaks を `/` で起動し、これらの環境変数を空にして渡すので、どれも効きません。ルールを変えるのは `configPath` だけです。
- `gitleaks:allow` / `betterleaks:allow` のコメントがある行も検査します（`--ignore-gitleaks-allow`）。
- 起動時に自己診断をします。`betterleaks version` が動くかに加え、作ったダミーの GitHub トークンを実際の引数でスキャンします。スキャンが失敗する（`configPath` の誤り、対応していない版など）と使えないと判断し、送信をすべて止めます。トークンを検出しないだけなら警告にとどめます。

## 同じ値には同じプレースホルダ

プレースホルダは `HMAC-SHA256(鍵, 秘密値)` の先頭 12 桁の 16 進数です。同じ値は、プロンプトでも `.env` でも別のツールの出力でも同じ `[REDACTED-…]` になるので、モデルは「この 2 か所は同じ値」「こちらは別の値」という文脈を保てます。

- 対応表をディスクに保存しません。値は同じ入力から同じ出力になるように計算するだけです。
- 鍵は `hashKey` です。空のときは初回の起動で乱数を作ってプラグインの store に保存するので、セッションや再起動をまたいでも同じプレースホルダになります。
- 鍵を使う理由は、素のハッシュだと弱いパスワードなどを辞書攻撃で逆算されうるためです。

## モデルへの通知

redact したとき、モデルだけが読む短い注記（英語）を添えます。内容は次のとおりです。

- 認証情報フィルタが値をプレースホルダに置き換えたこと
- 各プレースホルダの検出ルール（`github-pat` など）
- 本物の値は見えないこと
- ユーザーの画面には本物の値が見えているかどうか（`restoreInDisplay` に従う）
- どのツールの引数でプレースホルダが本物の値に戻るか（`restoreInToolInput` に従う）
- そのまま作業を続けてよく、値をユーザーに求めないこと

これでモデルは、ファイルが壊れていると誤解したり値の入力を求めたりせずに作業を続けられます。

| 経路                                                     | 注記の置き場所                    |
| -------------------------------------------------------- | --------------------------------- |
| ツール結果                                               | `context`（ユーザーには見えない） |
| 失敗したツール結果、下の層からの拒否                     | 置換後のエラー文の末尾            |
| プロンプト                                               | `context` の末尾                  |
| 添付、コンテキストブロック、セクション、スキル、配信、送信するメッセージ | 置換後の本文の末尾   |
| `session.append` の行（`!コマンド` など）                | 置換後の行の末尾                  |
| PostToolUse フックの差し替え                             | `additionalContext` の末尾        |

スラッシュコマンドの引数、圧縮への指示、他の mod のモデル呼び出しには注記を足しません（置換だけ）。block とスキャン失敗のときは拒否の理由を返します。クリーンな入力には何も足しません。

## ツール入力での復元

モデルが `[REDACTED-…]` を含むツール呼び出しをしたとき、この mod が覚えている（メモリ上の）対応で本物の値に戻してから実行します。たとえば `curl -H "Authorization: token [REDACTED-…]"` はそのまま動き、`.env` の Edit も値を含んだまま行えます。実行結果に本物の値が出てきても、出力側でまた置換されます。

- 戻すのは、この機械の上で動き、入力を別のモデルが読まないツールだけです: `Bash`、`PowerShell`、`Write`、`Edit`、`NotebookEdit`、`Read`、`Grep`、`Glob`。それ以外（MCP ツール、WebFetch（`prompt` を内部のモデルが読む）、WebSearch、`Agent`、`SendMessage`、`Workflow`、`CronCreate`、`Monitor`、`Skill` など。今後増えるツールも）にはプレースホルダのまま渡します。
- 戻せるのは、この mod がその読み込み中に置換した値だけです。未知のプレースホルダはそのまま渡します。
- **auto mode**: 許可が要る呼び出しは、auto mode の分類器（モデル）が判定します。分類器はこの mod が戻した後の入力を読みます（実セッションのデバッグログで確認）。そのため auto mode では、戻すと入力が変わる呼び出しについて、先に `$.tool.check` で判定を確かめます。許可ルールで通るものだけ戻して実行し、分類器に回るものは理由を添えて拒否します。拒否された場合は、ユーザーが自分で実行するか、許可ルール（例: `Bash(printf:*)`）を足すか、auto mode を抜けてください。権限モードは settings フックの入力（`classic.*` の `permission_mode`）から読みます。サブエージェントは、自分のモードが分かるまで auto mode と同じ扱いにします。
- 戻した値は、権限の確認ダイアログ、settings の PreToolUse / PermissionRequest フックの入力、`claude -p` の結果の `permission_denials` にも本物のまま現れます（モデルには渡りません）。
- 復元により、モデルが指示した先（`curl` の宛先など）へ本物の値が渡ることがあります。また、モデルがコマンドで値を加工（逆順・分割など）して出力させると、加工後の値は検出できません。これらを避けたい場合は `restoreInToolInput` を `false` にします。

## 画面表示での復元

モデルに渡る内容と履歴は置換したまま、**人間が見る描画だけ**本物の値に戻します（`ui.render`）。モデルの返答、ツールの行と結果、自分のプロンプト、スラッシュコマンドの出力、質問ダイアログが対象です。

- 戻せるのは、この mod が置換した値だけです。未知のプレースホルダはそのままです。
- 画面共有や録画には本物の値が映ります。無効にするには `restoreInDisplay` を `false` にします。
- 履歴やモデルが読む内容は変わりません。送信時だけ置換して履歴は本物の値のままにする方法は、mods API にありません（`turn.step` は送るメッセージを書き換えられず、書き換えた応答は履歴に記録されます）。
- `claude -p` や `--output-format stream-json` の出力は描画を通らないので、置換されたままです。thinking と、折りたたまれたツール群の 1 行要約も対象外です。
- 対応表（秘密値）はディスクに保存しません。`--resume` で再開した直後は、過去の行はプレースホルダのままです。その値にもう一度出会う（たとえば `.env` を再度読む）と、描き直されて本物の値になります。
- 再開後も同じ値が同じプレースホルダになるよう、`hashKey` が空なら初回の起動で鍵を自動生成し、プラグイン専用の store（Claude Code の設定ディレクトリ下の JSON ファイル。平文）に保存します。設定画面の `hashKey` は書き換わりません。決まった鍵を使いたいときは `/plugin configure` で `hashKey` を入力します（入力があれば store は使いません）。保存に失敗すると通知し、その起動の間だけ使うメモリ上の鍵で続けます。

## インストール

### 1. 前提を確かめる

```bash
claude --version      # 2.1.287 以上（それより古いと mod が読み込まれず、何も守られない）
betterleaks version   # 入っていること
which betterleaks     # IDE やデスクトップアプリから Claude Code を起動するなら、このパスを控えておく
```

betterleaks の入れ方の例: `brew install betterleaks`、`mise use -g aqua:betterleaks/betterleaks`、`go install github.com/betterleaks/betterleaks/v2@latest`。

IDE やデスクトップアプリから起動した Claude Code は、シェルの PATH（mise や Homebrew の設定）を引き継がないことがあります。その場合は `betterleaksPath` に `which betterleaks` の結果（絶対パス）を設定します。

### 2. 入れる

GitHub リポジトリ `skpersonal/claude-code-block-creds-mod` をマーケットプレイスとして追加し、そこから入れます。

```text
# Claude Code のセッション内で
/plugin marketplace add skpersonal/claude-code-block-creds-mod
/plugin install block-creds@block-creds-marketplace
```

追加と導入を 1 コマンドにまとめることもできます。

```text
/plugin install block-creds --marketplace skpersonal/claude-code-block-creds-mod
```

セッションを開かずにシェルから入れる場合は次のとおりです。設定も `--config` で同時に入れられます。

```bash
claude plugin marketplace add skpersonal/claude-code-block-creds-mod
claude plugin install block-creds@block-creds-marketplace            # 既定はユーザースコープ
claude plugin install block-creds@block-creds-marketplace --scope project   # リポジトリ単位で有効にする場合
claude plugin install block-creds@block-creds-marketplace --config betterleaksPath="$(which betterleaks)"
```

- 導入したあと、開いているセッションでは `/reload-plugins` を実行すると読み込まれます。
- 特定の版に固定する場合は、`skpersonal/claude-code-block-creds-mod#<ブランチ・タグ・コミット>` のように `#ref` を付けます（`claude plugin tag` で作るタグは `block-creds--v<版>` という名前です）。
- 更新は `claude plugin update block-creds@block-creds-marketplace`、削除は `claude plugin uninstall block-creds@block-creds-marketplace` です。
- 手元の clone を 1 セッションだけ試すには `claude --plugin-dir /path/to/claude-code-block-creds-mod` を使います。

### 3. 動いているか確かめる

`/block-creds` を実行します。`status: checking everything sent to the model` と `self-test: ok` が出れば動いています。コマンドが見つからない場合は、mod が読み込まれていません（Claude Code の版、`/plugin` の Installed タブ、`/reload-plugins` を確認）。

## 設定（userConfig）

| 名前                 | 既定値           | 内容                                                                                     |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `mode`               | `redact`         | `redact`: 置換して送る。`block`: 送らない                                                |
| `betterleaksPath`    | `betterleaks`    | 実行ファイルの名前またはパス                                                             |
| `configPath`         | なし             | betterleaks の設定ファイル（`-c`）。絶対パスで書く。省略すると betterleaks の既定ルール  |
| `hashKey`            | 初回に自動生成   | プレースホルダ用の鍵。空なら store に自動生成                                            |
| `restoreInToolInput` | `true`           | ローカルのツールの入力でプレースホルダを本物の値に戻す（[ツール入力での復元](#ツール入力での復元)） |
| `restoreInDisplay`   | `true`           | 画面の描画でプレースホルダを本物の値に戻す（モデルに渡る内容は変わらない）               |

`/plugin configure block-creds@block-creds-marketplace`（シェルからは `claude plugin configure block-creds@block-creds-marketplace`）で設定できます。

置換・ブロック・スキャン失敗のときは、toast に加えて、プロンプト下の status 行に内容を表示します。status 行は次のメッセージを送るまで残ります。どちらもモデルには渡りません。

## `/block-creds`

この mod の状態を表示します: Claude Code と betterleaks の版、自己診断の結果、使っているルール、mode と復元の設定、鍵の出どころ、このセッションで置換・ブロックした件数と検出ルール。うまく動いていないときは、直し方と mod を無効にする方法も表示します。betterleaks が動かない間も、このコマンドと `/plugin`、`/reload-plugins`、`/config` などのローカルなコマンドは使えます。

## トラブルシューティング

| 症状 | 原因 | 直し方 |
| --- | --- | --- |
| すべてのプロンプトが「could not check the prompt, so it was not sent」で止まる | betterleaks が見つからない、または動かない | `/block-creds` の how to fix に従う。betterleaks を入れるか、`betterleaksPath` に絶対パスを設定し、`/block-creds` か `/reload-plugins` で再確認する |
| IDE / デスクトップアプリでだけ止まる | Claude Code の PATH に betterleaks が無い | `betterleaksPath` に `which betterleaks` の結果を設定する |
| `configPath must be an absolute path` | `configPath` が相対パスや `~` 始まり | 絶対パスで書く |
| `betterleaks runs but its scan failed` | `configPath` の TOML の誤り、または betterleaks が古い | シェルで `betterleaks stdin -c <configPath>` を実行して原因を見る。`configPath` を空にすると既定ルールで動く |
| `did not detect a test GitHub token` | `configPath` のルールが既定ルールを含まない | 設定ファイルに `[extend] useDefault = true` を足す |
| `refused a Bash call with a redacted value that auto mode would hand to its classifier` | auto mode で、本物の値を使う呼び出しが分類器に回る | 自分で実行する、許可ルールを足す、auto mode を抜ける、のいずれか |
| Read した結果が「could not be replaced」で拒否される | 置換できない形の値（行番号以外の理由で結果と一致しない） | Bash の `cat` で読む |
| mod を一時的に止めたい | | `/plugin` から block-creds を Disable、またはシェルで `claude plugin disable block-creds@block-creds-marketplace` |

## 検出ルールを足す

検出は betterleaks の既定ルールのままです。たとえば AWS のアクセスキー ID は、**近く（5 行以内）にシークレットキーがあるときだけ**報告され、ID 単体は報告されません。URL に埋め込まれたパスワード（`postgres://user:pass@host`）や、XML 要素の中の値（`<password>…</password>`）も既定では検出されません。足したい場合は、既定を継承した設定ファイルを作って `configPath` に指定します（プロジェクトに置いた `.betterleaks.toml` は使われません）。 <!-- betterleaks:allow -->

```toml
# betterleaks.toml
[extend]
useDefault = true

[[rules]]
id = "aws-access-key-id"
description = "AWS access key ID, even without the secret"
regex = '''\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b'''
keywords = ["a3t", "akia", "asia", "abia", "acca"]
filter = '''
entropy(finding["secret"]) <= 3.0
|| matchesAny(finding["secret"], [`.+EXAMPLE$`])
'''
```

## 制限事項

- 画像と PDF の中身は検査しません。
- 置換できない形の値を含むツール結果は、redact モードでも deny します（モデルが読む形と結果の中身が、行番号の有無以外の理由で違う場合）。
- WebFetch はページ本文を内部の小さなモデルに渡してから結果を返します。ページ本文にある秘密値はそのモデルに届きます（結果は検査します）。API 側で実行されるツール（advisor など）も同じく対象外です。
- settings の prompt 型・agent 型フックは、フックの入力（ツールの入出力。復元した値を含む）を LLM に渡します。
- auto mode で、モードを切り替えた直後の呼び出しは、切り替え前のモードで判断することがあります（モードは settings フックの入力から読むため）。PreToolUse フックが後から `ask` を返した場合も分類器に回ります。
- `!コマンド` などの行は会話に保存される前に書き換えるだけで、行そのものを拒否できません。block モードや検査失敗のときは、本文を「伏せた」という文に差し替えて保存します。
- mod を読み込む前に会話に入っていた内容（`--resume` した会話の履歴など）は置換しません。
- 検出精度は betterleaks のルールに依存します。未知の形式は見つかりません。
- 検査のたびに betterleaks を 1 回起動します（1 回約 40 ms）。プロンプト、ツール結果、添付、コンテキストブロック、セクション、スキル、配信、`!コマンド` などの行ごとに 1 回です。起動時は自己診断で 2 回起動します。
- `--safe-mode`、`--bare`、`disableAllHooks` のときは mod が読み込まれず、何も守られません。
- Windows では確かめていません。
- 検査できないときは常に送りません（fail closed。設定で切り替えることはできません）。
  - betterleaks が使えない間は、短いテキストも含めてプロンプト・添付・ツール結果・`!コマンド`の行・引数付きのスラッシュコマンドをすべて止めます。使えるようになれば自動で解除されます。
  - 各フックが失敗した場合（例外や時間切れ）も、`.catch` でそのテキストを破棄します（session.append・skill.prompt は伏せ文に差し替え、prompt.context はブロックを、prompt.compose はセクションをすべて落とす）。

## 開発

前提: Claude Code 2.1.287 以降、`betterleaks`、Node.js、pnpm（Biome・TypeScript・husky などの開発用ツール）。ビルド工程はなく、Claude Code が `.ts` を直接読み込みます。

### 1. 型定義を用意する（最初と Claude Code を更新した後）

`.claude-plugin/types/` は手で作るものではなく、Claude Code がこの mod を読み込んだときに、インストールされている版に合わせて書き出します（`.gitignore` 済み）。2.1.312 では、対話セッションでホットリロードするフォルダとして読み込んだときだけ書き出され、`claude -p` では書き出されません。clone した直後は存在しないので、`tsc` の前に一度対話セッションで読み込ませます。

```bash
claude --plugin-dir .   # 起動したら /exit で終えてよい
ls .claude-plugin/types   # claude-code/ ... tsconfig.json
```

- `claude-code/index.d.ts` が API の正式な定義です（先頭の行に書き出した Claude Code の版が入ります）。イベントの入出力や `$` のメソッドは、Web のドキュメントよりこちらを優先してください。組み込みの plugin-authoring スキルを読み込むと、同じ定義が 1 ファイルでも渡されます。
- 書き出しのたびに `.claude-plugin/types/tsconfig.json` は上書きされます。そのため、`.ts` の import を許す `allowImportingTsExtensions` は、ルートの `tsconfig.json` 側に置いています。

### 2. 変更ごとに実行する

```bash
pnpm validate    # claude plugin validate . --strict。登録しているイベントと呼び出す API の一覧を確認
pnpm test        # claude plugin test。単体テストとイベントテスト（betterleaks はスタブ）
pnpm typecheck   # tsc -p .
pnpm lint        # biome check .（lint と整形の確認）
pnpm format      # biome check --write .（自動修正）
```

最初に `pnpm install` を実行してください（husky が `.husky/` の Git フックを有効にします）。コミット時には pre-commit フックが、ステージしたファイルへの `lint-staged`（Biome の自動修正）、`pnpm typecheck`、`pnpm test` を順に実行します。型チェックには手順 1 の型定義が必要です。

- `claude plugin test` はプラグインのディレクトリを受け取る形式で、テストファイルや単体のテストを指定する方法は見つかっていません。全体で数秒です。
- `validate` が出す `hooks:` と `calls:` の行に、意図したイベントと API が並んでいるかを見てください。イベント名の綴りミスはここで分かります。
- プロジェクト向けの指示は `.claude/CLAUDE.md` にあります（ルートに `CLAUDE.md` を置くと、`validate --strict` が「プラグインのコンテキストとしては読まれない」と警告して失敗するため）。
- イベントテストは `claude-code/testing` を使います。API 呼び出し（`$.process.run` など）のスタブは `{ value }` か `{ deny }` を返し、イベント（`tool.call`、`tool.check` など）のスタブはそのイベントの結果をそのまま返します。userConfig の値は `test(名前, { options: { mode: 'block' } }, 本体)` で渡します。classic イベントは `$.classic.UserPromptSubmit({ ... })` のように起こせます（下に答えるスタブが要ります）。
- テストからは、他の mod の `$.model.complete` などの呼び出しを再現できません（テストのモジュールの `$` 呼び出しは許可されない）。`model.*` のフックは `validate` の一覧と実セッションで確かめます。

### 3. 実際のセッションで確かめる

スタブのテストでは、結果のスキーマ検証や、実際のセッションがモデルに何を送るかは分かりません（AWS のシークレットキーの取りこぼしは、この確認で見つかりました）。フックの結果を変えたときは、ダミーの認証情報で必ず実行してください。

```bash
# ダミーの .env を作業ディレクトリの外に作る（アクセスキー ID は [A-Z2-7] の 16 文字、シークレットは 40 文字）
mkdir -p /tmp/e2e && cd /tmp/e2e
AK="AKIA$(LC_ALL=C tr -dc 'A-Z2-7' </dev/urandom | head -c16)"
SK="$(LC_ALL=C tr -dc 'A-Za-z0-9/+' </dev/urandom | head -c40)"
GH="ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c36)"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nGITHUB_TOKEN=%s\n' "$AK" "$SK" "$GH" > .env

# 実行して、モデルに渡った内容（stream-json）に値が残っていないか数える
claude -p "Read .env and tell me every key and token in it, character for character." \
  --plugin-dir /path/to/claude-code-block-creds-mod --output-format stream-json --verbose \
  < /dev/null > out.jsonl
for s in "$AK" "$SK" "$GH"; do grep -c -F "$s" out.jsonl; done   # すべて 0 なら漏れていない
grep -o '\[REDACTED-[0-9a-f]*\]' out.jsonl | sort | uniq -c       # 同じ値は同じプレースホルダ
```

確かめるとよい経路と条件:

- Read、Bash の `cat`、プロンプトへの直接貼り付け、`@.env` のメンション
- XML の中の AWS キー、`# gitleaks:allow` 付きの行、Read で読む複数行の秘密鍵（`tests/dummy-private-key.txt`）
- 作業ディレクトリに全部許可の `.gitleaks.toml` と `:github-pat:1` を書いた `.gitleaksignore` を置く、`GITLEAKS_CONFIG_TOML` に全部許可の設定を入れる（どれも効かないこと）
- ツール入力での復元: Claude に「Read した値を使って `printf '%s' <値> > copy.txt` を実行させる」と、`copy.txt` に本物の値が入る（`--allowedTools "Read" "Bash"` が要る）。許可されずに拒否された呼び出しは、`result` 行の `permission_denials` に本物の値のまま載ります（モデルには渡らないので、grep で数えるときは除く）
- auto mode: `--permission-mode auto` で同じことをさせると理由付きで拒否され、`--debug-file` のログに `classifier_request_started` が出ない。`--allowedTools "Bash(printf:*)"` のように許可したコマンドは復元されて動く（auto mode では `Bash` だけの許可はエンジンが外す）
- betterleaks が無いとき: `betterleaksPath` を存在しないパスにすると、通常のプロンプトは直し方付きで止まり、`/block-creds` は動く

設定は `--settings` で渡せます。

```bash
cat > block-settings.json <<'EOF'
{"pluginConfigs": {"block-creds@inline": {"options": {"mode": "block"}}, "@inline/block-creds": {"mode": "block"}}}
EOF
claude -p "My token is $GH . Say hi." --plugin-dir /path/to/claude-code-block-creds-mod --settings block-settings.json < /dev/null
# => Prompt dropped by a hook: block-creds: the prompt contains credentials (github-pat), so it was not sent
```

上の設定には 2 通りのキー表記を両方入れてあり、どちらが効いたかは切り分けていません。

画面での復元（`ui.render`）と status 行は対話セッションでしか確かめられません。`claude --plugin-dir .` で `.env` を Read させ、画面に本物の値が、モデルの返答の引用にはプレースホルダが出ることを見てください。

### 4. コードの構成

`hooks/register.ts` が入口です。`$`（mods API）を渡せるのは同じファイル内の関数だけなので（`validate` が検査します）、betterleaks を起動する処理は `register.ts` にあります。純粋なロジックは `redactor.ts`（置換、HMAC、`forScan`、行番号外し）と `scanner.ts`（betterleaks の引数・環境変数と出力の解釈）に分けてあり、テストから直接 import できます。

betterleaks の出力は入れ子になることがあります。`aws-secret-access-key` は `aws-access-token` の `ComponentSets[].components[]` の中にだけ現れます。`scanner.ts` は全体をたどって `Secret` を集めているので、最上位だけを読む実装に戻さないでください。
