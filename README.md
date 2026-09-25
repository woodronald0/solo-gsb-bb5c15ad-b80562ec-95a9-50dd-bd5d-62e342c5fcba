# 骑马钉小册子 PDF 拼版（Booklet Imposer）

供小型印刷店使用的小册子 PDF 拼版 Web 应用。上传 PDF 后，系统按**每张纸容纳 4 页**的骑马钉规则自动重排页码，提供每张纸正反页序预览，并可下载拼版后的 PDF。支持可选的**分册签帖模式**：按纸张容量把长文档切成多个连续签帖分别骑马钉排版。支持可选的**印张定位标记**：版心四周各增加 8 mm 空白，正背两面四角绘制仅位于版心之外的裁切线、中央折线上下端绘制定位线，拼版方案记录实际输出印张宽高，用纸报价按该宽高判断纸张能否容纳并计算利用率。支持可选的**骑马钉爬移补偿**：输入纸厚（0.05～0.5 mm），每帖从外到内按帖内张号计算单侧内移量＝（张号－1）×纸厚，同一印张正背两面左页向右、右页向左平移并在各自半区内裁切（补白保持空白，页序与纸张尺寸不变），分册签帖各帖分别从零计算，拼版方案与页面摘要逐张列出补偿量，缺页补印沿用本次纸厚与选项。另提供**独立的 PDF 印前校验报告**：上传后可先逐页检查页面尺寸、旋转角、透明度与可提取文字，按严重级别汇总并把相邻同类问题合并为区段，支持按级别筛选与下载 JSON；校验**只检查不拼版，且不阻断后续拼版**。还提供**批量印前校验与交付放行判定**：一次选择最多 10 个 PDF，服务端按选择顺序逐个复用单文件校验，单个文件缺失、损坏或加密只记录该文件的失败原因、不阻断其他文件，结果按问题代码汇总总次数与涉及文件；可**按问题代码设置放行处置（阻断交付 / 需复核 / 忽略，未设置时错误默认阻断、警告默认需复核、提示默认忽略）**，逐文件按「阻断优先于警告」判为**阻断交付、需复核或放行**，无法校验的文件标为**未判定**，页面同时展示检测结论与放行结论，下载的完整批量 JSON 包含策略快照与逐文件判定。还提供**印前报告差异对比**：分别上传基准 PDF 与待交付 PDF，服务端复用逐页校验并按「页码 + 问题代码」对齐，返回**新增、已解决、仍存在的问题及页数变化**，支持页级明细查看与差异 JSON 下载。拼版完成后还可得到**印刷用纸报价**：维护最多 8 种纸张规格（宽、高、单价、开机费），系统按拼版的统一面板尺寸、纸张数与分册签帖枚举纸张旋转方向并选择能容纳版面的最低总成本方案，报价可下载 JSON。拼版结果中还提供**批量裁切下料**：输入所需印张数，系统沿用实际输出印张尺寸与维护的纸张规格，用带记忆化的矩形分割搜索生成**可执行的直线贯通裁切树**（印张可旋转 90°，非面积估算、非重叠摆放），按原纸展示裁切图、单张产出、所需原纸张数与尾张余量，并按所需原纸张数、废料面积依次推荐方案，支持裁切 JSON 下载；尺寸或数量非法时给出明确错误，无可行方案时说明原因。拼版结果区另提供**缺页补印**：输入受损的原稿页码或区间（如 `2,5-7`），服务端按本次拼版选项复用拼版方案定位受损页所在印张，同一印张命中多页只补印一次，按原印张顺序成对抽取正背面生成可下载的补印 PDF（保留原印张尺寸与定位标记），页面逐张列出帖号、帖内张号与命中页码。

技术栈：Node.js + Express + 原生 HTML/CSS/JavaScript + [pdf-lib](https://pdf-lib.js.org/)。

## 印刷用纸报价

拼版前可在页面上方「印刷用纸规格」卡片维护**最多 8 种纸张规格**（名称、宽 mm、高 mm、单价 元/张、开机费 元/次），规格只保存在本机浏览器（localStorage），首次打开内置 A3 / A2 / 正度对开三种示例可直接修改或删除。

每次「开始拼版」成功后，摘要中自动发起报价；修改纸张规格后点击「**按当前纸张重新报价**」即可刷新。计算规则：

- **版面尺寸**：取拼版方案记录的**实际输出印张宽高**（`plan.sheet`，启用印张定位标记时含版心四周各 8 mm 空白）；旧方案无该字段时回退为 `2 × 面板宽` × `面板高`（pt 自动换算为 mm）。
- **枚举方向**：对每种纸张分别尝试**原向**与**旋转 90°**，任一方向能容纳即为可行；两个方向都可行时选择空余（slack）最小的方向，相同时优先原向。
- **纸张数与开机次数**：整册模式纸张数 = 拼版纸张数、开机 1 次；**分册签帖模式每帖各开机 1 次**（开机费 = 开机费 × 帖数）。
- **成本**：纸张费 = 单价 × 纸张数；开机费 = 单次开机费 × 开机次数；**总价 = 纸张费 + 开机费**。
- **有效利用率** = 单张印张版面面积 ÷ 纸张面积（按实际输出印张宽高计算；如 A4 竖版小册子未启用标记时展开恰好铺满 A3，利用率 100%）。
- **选优**：在所有可行纸张中选择**总价最低**者；总价相同时依次按利用率更高、纸张面积更小、维护顺序更靠前决胜。
- **不能容纳**：所有纸张（两个方向）都放不下时返回 `feasible: false`，逐种纸张列出原向与旋转后的**宽/高不足量（mm）**及展开印张尺寸，前端以红色横幅展示明确原因（HTTP 仍为 200，属于正常报价结果）。

前端在拼版摘要中列出每种纸张的摆放方向、有效利用率、纸张费、开机费与总价，可点选**切换纸张方案**（切换即时生效，无需再次请求），并通过「**下载报价 JSON**」导出（文件名形如 `原名-用纸报价.json`，其中 `selected` 为当前选中的方案）。

## 批量裁切下料

拼版完成后，在拼版摘要的「**批量裁切下料**」卡片输入**所需印张数**（1～1000000 的整数，即本次一共需要多少个拼版输出的印张），点击「计算裁切方案」。系统沿用拼版方案 `plan.sheet` 的**实际输出印张尺寸**（启用定位标记时含四周 8mm 空白）与「印刷用纸规格」卡片维护的纸张规格，对每种原纸计算如何把大纸裁成印张：

- **允许印张旋转 90°**：同时枚举原纸原向与旋转 90° 两个摆放方向，并允许同一张原纸上的印张混合朝向摆放。
- **可执行的直线贯通裁切树（guillotine cut tree）**：用**带记忆化的矩形分割递归搜索**排料——每一步要么在矩形左下角放 1 个印张，要么沿竖直/水平方向做一条**贯通整个当前料件的直线**切成两条子料件并递归；切位只枚举印张边长的整数倍（最优方案的贯通线总能平移到某一印张边缘）。**不使用面积估算，也不允许印张跨线或重叠摆放**（测试与裁切 JSON 中的坐标可直接校验：全部印张互不重叠、不越界，每条裁切线均贯通其所在料件）。
- 每种原纸展示：**按真实比例的裁切图**（红虚线为贯通裁切线，深色块为原向印张、浅色块为旋转 90° 的印张，位内编号）、可展开的**逐刀裁切顺序**（注明每刀所在料件尺寸、方向与距边位置）、**单张产出**（每张原纸裁出的印张数）、**所需原纸张数**（`ceil(所需印张数 ÷ 单张产出)`）与**尾张余量**（整除时无尾张；否则前 N 张出满，尾张只裁余数个、尚余若干个位）。
- **废料面积**：单张废料（原纸面积减去裁出印张面积，取自裁切树的废料叶区域）、尾张废料与总废料；恰好铺满时严格为 0。
- **推荐排序**：可行方案先按**所需原纸张数从少到多**，张数相同时按**总废料面积从小到大**，再相同按单张产出与维护顺序；推荐方案带「推荐」徽标。
- **非法输入**：印张数不是 1～1000000 的整数、纸张宽高非正、缺少 plan/papers 等由服务端返回 `400` 并给出明确错误（前端同样即时拦截）。
- **无可行方案**：所有原纸两个方向都裁不下印张时（HTTP 仍为 200），`feasible: false`，逐种原纸列出原向与旋转 90° 后的宽/高不足量并汇总原因；单张可裁数量超过 10000 个的异常规格组合会跳过搜索并说明原因。

结果可通过「**下载裁切 JSON**」导出（文件名形如 `原名-批量裁切下料.json`），内含每种原纸的单张产出、所需张数、尾张余量、废料面积、印张与裁切线的绝对 mm 坐标以及完整裁切树。裁切模块与报价模块**复用同一套纸张规格与同一个拼版结果**；修改纸张规格或印张数后，卡片会提示点击「计算裁切方案」刷新。

## 缺页补印

印刷完成后若只有部分原稿页受损（如装订废品、弄脏重印），无需重印整册。拼版完成后，在拼版结果区的「**缺页补印**」卡片输入**受损原稿页码或区间**（如 `2,5-7`，逗号分隔，支持全角逗号与全角区间号），点击「生成补印 PDF」。系统把**原 PDF 与本次拼版选项**（整册/分册签帖、每帖纸张数、定位标记、**骑马钉爬移补偿与纸厚**）一起提交给 `/api/reprint`，服务端**复用拼版方案**逐张纸检查正/背面四个槽位来定位受损页码：

- **同一印张命中多页只补印一次**：一张纸上命中多个受损页时，该纸只抽取一次；
- **分册签帖模式累计输出页偏移**：每帖占 `2 × 帖内张数` 个输出页，据此把帖内张号换算为完整拼版输出中的页码；
- **按原印张顺序成对抽取正、背面**组成补印 PDF：补印页为完整拼版输出页的逐页原样复制，**保留原印张尺寸、定位标记与爬移补偿**（启用爬移时内移平移与半区裁剪与完整拼版对应印张完全一致；每张补印纸回传其单侧内移量 `creepShiftMm`，分册签帖按帖内张号标注）；
- 页面逐张列出每张补印纸的**帖号（分册模式）、帖内张号与命中页码**，补印 PDF 通过「**下载补印 PDF**」保存（文件名形如 `原名-补印.pdf`）。

**输入校验**：空输入、无法识别的格式（如 `abc`、`2,`）、区间起点大于终点、页码越界（小于 1 或超过原稿页数）都会给出明确错误（前端即时拦截空输入，其余由服务端返回 `400`）；损坏或加密的 PDF 返回 `422`。**重新拼版或更换文件后，旧的补印结果自动清空**；补印与报价、裁切模块相互独立，互不影响。

## 印前校验报告（独立于拼版）

上传 PDF 后可先点击「运行印前校验」，服务端**仅逐页检查、不生成拼版文件**，返回结构化 JSON 报告。检查项与严重级别：

| 检查项 | 问题代码 | 严重级别 | 判定说明 |
| --- | --- | --- | --- |
| 页面尺寸 | `size_mismatch` | 警告 | 以多数页（主尺寸，容差 1pt）为准，标出物理介质尺寸不一致的页面 |
| 旋转角 90°/270° | `rotated_90_270` | 警告 | 页面带 `/Rotate`，阅读器中呈横向显示 |
| 旋转角 180° | `rotated_180` | 错误 | 内容上下颠倒，拼版后仍为颠倒状态 |
| 透明度 | `transparency` | 警告 | 页面透明图层组、非不透明 Alpha（`/ca`、`/CA`）、`/SMask` 软蒙版、非 Normal 混合模式（含 Form XObject 递归检测） |
| 可提取文字 | `no_extractable_text` | 提示 | 页面无文本绘制操作，或所用字体缺少 `ToUnicode`（扫描图/转曲页常见） |
| 末尾补白 | `blank_padding` | 提示（文档级） | 页数不是 4 的倍数时，提示拼版将补的空白页数 |

- **区段合并**：相邻页面的同类问题（同一代码）自动合并为一个区段，报告给出页码范围（`pageFrom`/`pageTo`/`pages`）、连续页数、逐页检测值（`detected`）与去重后的可读摘要（`values`），并附**修复建议**（`advice`）。
- **结论**：`summary.passed` 仅表示无**错误级**问题；警告/提示仍会列出。页面无法判定（如内容流使用了不支持的过滤器）时该页对应检查项跳过，避免误报。
- **不阻断拼版**：即使报告含错误，也仍可直接点击「开始拼版」；两个接口互不依赖。
- 前端提供：错误/警告/提示数量汇总卡、**按级别筛选**（全部/错误/警告/提示）、问题区段列表（范围 + 检测值 + 修复建议）、可展开的逐页检测明细表，以及「**下载 JSON 报告**」（文件名形如 `原名-印前校验报告.json`）。

## 批量印前校验与交付放行判定（一次最多 10 个 PDF）

页面中部「批量印前校验」卡片可一次选择 **1～10 个 PDF**（超过 10 个时前端直接拦截，服务端同样返回 `400`）。点击「开始批量校验」后，服务端**按选择顺序逐个复用与 `/api/preflight` 完全相同的单文件校验**，规则：

- **单文件失败不阻断整批**：某个文件缺失内容（0 字节）、不是 PDF、损坏或加密时，只在该文件的结果中记录失败原因（`status: "failed"` + `errorCode` + `error`），其余文件照常校验；即使全部文件失败，接口也返回 `200`。
- **失败代码**：`not_pdf`（不是 PDF 或文件为空）、`invalid_pdf`（损坏/无法解析）、`encrypted_pdf`（已加密）、`empty_document`（不含任何页面）。
- **逐文件检测结果（保持原含义）**：每个文件给出通过状态（`passed`，仅无错误级问题）、页数与错误/警告/提示数量，成功文件的**完整单文件报告原样内嵌**在 `report` 字段中。
- **按问题代码汇总**：`issueTotals` 按问题代码（`code`）统计**总次数**（同一文件内同一代码计 1 次，文档级问题计 1 次）与**涉及文件**（序号 + 文件名），按 错误 → 警告 → 提示 排序，并额外标注该代码当次的放行处置（`action`）与来源（`actionSource`：默认/自定义）。

### 交付放行策略

卡片中的「**交付放行策略**」可展开，按问题代码单独选择处置，策略只保存在本机浏览器（localStorage），随每次批量校验提交，并完整写入下载的批量 JSON：

| 处置（action） | 含义 |
| --- | --- |
| `block` | **阻断交付**：命中该代码的文件不予放行 |
| `warn` | **需复核**：命中该代码的文件需人工确认后放行 |
| `ignore` | **忽略**：已知悉/接受，该代码不影响放行 |

- **默认处置**：某代码未单独设置时，按其**检测级别**取默认值——**错误（error）→ 阻断（block）、警告（warning）→ 需复核（warn）、提示（info）→ 忽略（ignore）**。
- 逐文件放行判定（`files[].release.decision`）：命中的代码中**只要存在 `block` 即判为 `blocked`（阻断交付）；否则存在 `warn` 判为 `review`（需复核）；都没有则 `passed`（放行）**——即**阻断优先于警告**。
- **无法校验的文件不参与判定**，单独标为 `undetermined`（未判定），需补传可正常解析的 PDF 或人工确认。
- **整批放行结论**（`summary.release.decision`）优先级为 **`blocked`（阻断） > `undetermined`（未判定） > `review`（需复核） > `passed`（放行）**：有任一阻断文件整批即阻断；无阻断但有无法校验文件时整批不直接放行；其次看是否有需复核文件。
- **检测结论与放行结论相互独立、同时展示**：文件级 `passed` 与整批 `summary.allPassed` 仍只表示「无错误级问题」，含义完全不变；例如把错误代码 `rotated_180` 自定义为「忽略」后，文件的 `passed` 仍为 `false`，但放行判定可以是「放行」。
- 每个文件的 `release.triggered` 列出**触发的代码及处置**（代码、检测级别、标题、区段数、处置、来源），按 阻断 → 警告 → 忽略 排序；展开页面行可在每个问题旁看到对应的放行处置徽标。

前端提供：**检测结论与交付放行两个结论横幅**、文件总数/检测通过/无法校验/错误/警告/提示与**放行阻断/需复核/可放行/未判定**两组汇总卡、**可展开的文件结果表**（同时显示检测状态与放行判定，展开后含放行结论文字与逐问题处置）、按问题代码汇总表（含处置列）、**本次放行策略明细表**（逐代码的处置与默认/自定义来源），以及「**下载完整批量 JSON**」（文件名 `批量印前校验报告.json`，内含 `releasePolicy` 策略快照、`summary.release` 整批结论与每个文件的 `release` 判定）。

批量校验只做检查、不生成拼版文件，与单文件校验、差异对比、拼版完全独立；原有 `/api/preflight` 单文件接口的请求与响应结构保持不变；批量接口在原响应上**只新增字段**，旧消费方不受影响。

## 印前报告差异对比（基准版 vs 待交付版）

页面中部「印前报告差异对比」卡片可分别选择两个 PDF：

- **基准 PDF**（`baseline`）：上一版 / 客户确认版；
- **待交付 PDF**（`delivery`）：本次重新导出、准备交付印刷的版本。

点击「对比两份报告」后，服务端对两份文件**分别复用同一套逐页校验**（与 `/api/preflight` 完全一致的检查逻辑），再按以下规则对齐：

1. **逐页问题按「页码 + 问题代码」对齐**，归入三组：
   - **新增问题（added）**：基准中不存在、待交付中出现的问题（如重新导出后某页引入了透明度或 180° 旋转）；
   - **已解决（resolved）**：基准中存在、待交付中消失的问题；
   - **仍存在（persistent）**：两份报告在相同页码命中同一代码；同时逐页比对检测值（如旋转角、透明来源），变化的页码列入 `detailChangedPages`。

   同一代码只在部分页码上消失/新增时，会同时出现在多个分组中，各分组仅包含对应页码。
2. **文档级问题仅按代码对齐**（无页码，如 `blank_padding` 补白提示）：随页数变化出现、消失或文案变化（变化时 `detailChanged=true`），同样归入三组。
3. **页数变化**：按页码对齐，超出对方页数的尾部页面记为新增页 / 移除页（工具不比对页面内容，不识别插入/删除导致的整体位移）；保留页同时给出尺寸、旋转角、透明度、可提取文字是否变化的标记。

前端提供：结论横幅（是否引入/残留**错误级**问题）、两份文件名与页数变化（`基准页数 → 待交付页数`、新增/移除页数）、新增/已解决/仍存在数量卡、**按差异类型切换**的问题列表（含基准与待交付两侧检测值与修复建议）、**页级差异明细表**（每页状态 + 指标变化 + 三类问题代码），以及「**下载差异 JSON**」（文件名 `印前报告差异对比.json`）。

对比只做检查、不生成拼版文件；**任一文件缺失或不是 PDF 返回 `400`，任一 PDF 损坏/加密返回 `422` 并在错误信息中标明是「基准 PDF」还是「待交付 PDF」**。对比接口与单文件校验、拼版完全独立，任何对比失败都不会影响 `/api/preflight` 与 `/api/impose`。

## 拼版规则

- 每张纸正反两面共放置 4 个页面（每面左右各一页）。
- 页数不是 4 的倍数时，在**文档末尾补空白页**后再拼版。
- 页码排列（从外向内，逐层递进）：
  - 第 1 张纸 **正面**：`末页 | 首页`
  - 第 1 张纸 **背面**：`第 2 页 | 倒数第 2 页`
  - 第 2 张纸 **正面**：`倒数第 3 页 | 第 3 页`
  - 第 2 张纸 **背面**：`第 4 页 | 倒数第 4 页`
  - ……依次向内递进。
- 输出纸张为横向，未启用定位标记时尺寸 = `2 × 面板宽` × `面板高`（如 A4 竖版小册子 → A3 横向）；每个原始页按**原页面尺寸 1:1**放置，不缩放。
- **混合尺寸适配**：各页尺寸或旋转方向（/Rotate）不一致时，按每页**旋转后的有效宽高**取全部页面宽高的最大值作为**统一面板尺寸**；每页按其显示方向 1:1 居中放入对应半区，空余区域透明留白。拼版摘要中会显示统一面板尺寸与页面方向（竖版 / 横版 / 方形）。

> 说明：页面尺寸不一致或带旋转的 PDF 会按上述规则自动适配，无需预先统一页面尺寸；页序与末尾补白规则不受影响。

### 分册签帖模式（可选）

当页数较多、整册骑马钉太厚不便折页装订时，可启用「分册签帖」：

1. 设置**每帖最多纸张数**（1～20 的整数，每张纸容纳 4 页，即单帖容量为 `4 × 纸张数`，4～80 页）。
2. 系统按**原页序**把文档切成容量为 `4 × 纸张数` 的连续签帖：前序各帖装满，**最后一帖不足上限时按实际页数所需纸张数收尾**。
3. 每个签帖**仅在该帖自身末尾补白**（0～3 页），并各自独立按骑马钉规则排版；帖内纸张编号独立从 1 开始。
4. 输出 PDF 按**帖号顺序连续**拼接为一个文件；摘要与预览中逐帖标明**帖号、原始页范围、帖末补白数与帖内纸张编号**，下载仍为单个 PDF。

非法上限（0、21、小数、非数字、空值等）会在前端即时拦截，后端同样返回 `400` 拒绝。未勾选启用时完全保持原有整册拼版行为，接口字段与方案结构均向后兼容。

### 印张定位标记（可选）

勾选「添加印张定位标记」后，在**版心**（原拼版版面：`2 × 面板宽` × `面板高`）**四周各增加 8 mm 空白**，输出印张尺寸变为：

```
宽 = 2 × 面板宽 + 16 mm
高 = 面板高 + 16 mm
```

标记规则（正、背两面均绘制，**整册与分册签帖均适用**）：

- **四角裁切线**：版心的每个角各画水平、垂直两条线段，从版心边缘一直画到纸张边缘，**线段仅位于版心之外的 8 mm 空白区内**，不进入成品版心；
- **中央折线定位线**：左右面板分界线（中央折线）的**上端、下端**在空白区内各画一条定位线，同样不进入版心；
- **源页仍按原尺寸与页序放置**：内容不缩放、页码排列与补白规则完全不变，只是整体随版心向纸张中部偏移 8 mm。

拼版方案中**记录实际输出印张宽高**（`plan.sheet = { width, height }`，pt）与标记状态（`plan.marks = { enabled, marginMm }`）；**用纸报价按该实际宽高**枚举纸张原向 / 旋转 90° 判断能否容纳，并按实际印张面积计算利用率（例如 A4 竖版启用标记后印张约为 436 × 313 mm，原本恰好容纳的 A3（420 × 297）将判为放不下）。拼版摘要中会显示**标记开关状态与当前印张尺寸**（pt 与约合 mm）。

**未勾选时输出尺寸、页序与报价结果与之前完全一致**；接口字段 `registrationMarks=on` 为可选项，方案中的 `sheet`/`marks` 为新增字段，旧消费方不受影响。

### 骑马钉爬移补偿（可选）

骑马钉装订时内帖折页位置会因纸张厚度向外偏移（creep / 爬移），勾选「启用骑马钉爬移补偿」并填写**纸张厚度**（`0.05～0.5 mm`）后，系统对每张纸按其在帖内的张号做内移：

```
单侧内移量 = （帖内张号－1）× 纸厚（mm）
```

- **从外到内逐张递增**：每帖最外层第 1 张内移 `0 mm`（不平移），第 2 张内移 `1 × 纸厚`，第 3 张 `2 × 纸厚`……**分册签帖各帖分别从零计算**（每个签帖的第 1 张都是 0）。
- **平移方向**：同一印张**正、背两面相同**——左页向右、右页向左平移（朝中央折线/书脊方向内移）。
- **槽位裁切在各自半区**：内移后越过半区边界（含越过中央折线）的内容按半区矩形裁剪，不进入另一半区；**补白槽位保持空白**（不绘制、不裁剪）。
- **页序与纸张尺寸不变**：页码排列、补白规则、用纸数量与输出印张尺寸（`plan.sheet`）完全不变；与定位标记可叠加使用（半区随版心整体偏移 8 mm）。
- 拼版方案 `plan.creep = { enabled, paperThicknessMm }` 记录开关与纸厚，每张纸的 `sheet.creep.shiftMm` 给出该帖帖内张号对应的单侧内移量；拼版结果摘要逐张列出**张号与单侧内移量**（分册签帖按帖分别列出），纸张预览的每张标题也标注内移量。

**未勾选时方案与输出 PDF 与之前完全一致**；勾选但纸厚为空、非数字或不在 `0.05～0.5 mm` 区间时，前端即时拦截、后端返回 `400` 并给出明确错误。

## 一条命令启动（Docker Compose）

需安装 Docker（含 Compose 插件）。无需手动安装依赖或克隆 npm 包，在项目根目录执行**单条命令**即可完成镜像构建并后台启动全部服务：

```bash
docker compose up -d --build
```

镜像构建时自动完成 `npm install`，容器启动即服务就绪，无需手动安装依赖。容器同时提供拼版、单文件印前校验、批量印前校验（含交付放行判定）、印前报告差异对比、用纸报价、批量裁切下料与缺页补印七类接口，无需额外端口或环境变量（骑马钉爬移补偿为拼版/补印接口的可选表单字段，无需额外配置）。

启动后在浏览器访问入口地址：

```
http://localhost:3000
```

所有功能（上传拼版、印前校验、批量校验、差异对比、用纸规格维护、用纸报价、批量裁切下料、缺页补印）均在该页面内完成，无需其它入口或端口。

查看日志用 `docker compose logs -f`；停止：

```bash
docker compose down
```

## 本地运行（不使用 Docker）

要求 Node.js >= 18。

```bash
npm install
npm start
```

然后访问 http://localhost:3000 。

## 配置

通过环境变量配置（在 `docker-compose.yml` 的 `environment` 中修改）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（容器内端口） |
| `MAX_FILE_SIZE_MB` | `50` | 单个上传 PDF 的大小上限（MB）；差异对比接口中基准与待交付两份文件、批量校验接口中每个文件均各自独立适用该上限 |

如需更换宿主机映射端口，修改 `docker-compose.yml` 中 `ports` 的左侧端口，例如 `"8080:3000"`，然后访问 http://localhost:8080 。

> 每帖纸张数上限固定为 1～20（前端页面上的「每帖最多纸张数」与接口字段 `maxSheetsPerSignature` 均按此范围校验，非法值前后端都会拒绝），无需环境变量配置。骑马钉爬移补偿的纸厚范围固定为 **0.05～0.5 mm**（前端「纸张厚度」输入框与接口字段 `paperThicknessMm` 均按此范围校验，启用 `creepCompensation=on` 时必填，非法/缺失前后端都会拒绝），同样无需环境变量配置。批量印前校验的文件数量上限固定为 10 个（前后端同样各自校验），也无需环境变量配置。

## 使用方式

1. 浏览器打开应用，点击或拖入要拼版的 PDF。
2. 在「印刷用纸规格」卡片维护纸张（最多 8 种：宽/高 mm、单价元/张、开机费元/次；保存在本机浏览器，可随时「恢复默认」）。
3. （可选，建议先做）点击「运行印前校验」：查看错误/警告/提示汇总，按级别筛选问题区段，展开逐页明细，需要时下载 JSON 报告。校验不生成拼版文件，也不会阻止后续拼版。
4. （可选）在「批量印前校验」卡片展开「**交付放行策略**」，按需把问题代码设为阻断交付 / 需复核 / 忽略（留空即按默认：错误阻断、警告复核、提示忽略；策略保存在本机浏览器）。然后一次选择 **1～10 个 PDF**，点击「开始批量校验」：同时查看**检测结论**（每个文件的通过状态与错误/警告/提示数量）与**交付放行结论**（阻断交付 / 需复核 / 放行 / 未判定及触发代码与处置），点击行展开该文件的问题明细或失败原因，需要时下载含策略快照与逐文件判定的完整批量 JSON。该操作不影响上方单文件校验与拼版。
5. （可选）在「印前报告差异对比」卡片分别选择**基准 PDF**与**待交付 PDF**，点击「对比两份报告」：查看新增/已解决/仍存在问题、页数变化与页级明细，需要时下载差异 JSON。该操作不影响上方已选文件的校验与拼版。
6. （可选）勾选「启用分册签帖模式」，填写每帖最多纸张数（1～20）；不勾选则整册拼版。
7. （可选）勾选「添加印张定位标记」：版心四周各留 8 mm 空白并绘制四角裁切线与中央折线定位线（整册与分册签帖均适用）；不勾选时输出尺寸与页序保持原样。
8. （可选）勾选「启用骑马钉爬移补偿」，填写纸张厚度（0.05～0.5 mm）：每帖从外到内单侧内移量＝（帖内张号－1）×纸厚，正背两面左页向右、右页向左平移并在各自半区裁切（分册签帖各帖分别从零计算），页序与纸张尺寸不变；不勾选时输出保持原样。
9. 点击「开始拼版」（无论校验报告是否有问题都可以执行）。
10. 查看拼版摘要（原始页数 / 补白页数 / 用纸张数 / 统一面板尺寸 / 页面方向 / **印张尺寸 / 定位标记状态 / 爬移补偿状态与逐张单侧内移量**）与每张纸正反面的页码预览；斜纹块表示补的空白页。
   - 分册签帖模式下，摘要另列出各帖的**帖号、原始页范围、原始页数、帖末补白数与帖内纸张编号**，预览按帖分组并标注「第 N 帖 · 帖内第 M 张纸」。
11. 在摘要的「**印刷用纸报价**」中查看自动选中的最低成本方案（按实际印张宽高判断容纳、计算摆放方向 / 有效利用率 / 纸张费 / 开机费 / 总价），可切换其它可行纸张、在修改规格后点击「按当前纸张重新报价」，或下载报价 JSON；全部纸张都放不下时，这里会逐种给出原向与旋转后的宽/高不足量。
12. 在摘要的「**批量裁切下料**」中填写本次**所需印张数**并点击「计算裁切方案」：查看每种原纸的按比例裁切图与逐刀裁切顺序、单张产出、所需原纸张数、尾张余量与废料面积（方案按所需张数、废料面积推荐）；全部原纸都裁不下时逐种给出两个方向的不足量；可下载含坐标与裁切树的裁切 JSON。纸张规格或印张数修改后点击按钮即可重新计算。
13. （可选）在摘要的「**缺页补印**」中输入受损原稿页码或区间（如 `2,5-7`）并点击「生成补印 PDF」：系统按本次拼版选项（含纸厚与爬移补偿）复用拼版方案定位受损页所在印张（同一印张命中多页只补印一次），逐张列出帖号、帖内张号、单侧内移量与命中页码，点击「下载补印 PDF」保存（与完整拼版对应印张一致，保留原印张尺寸、定位标记与爬移平移/裁切）；空输入、格式错误或越界页码会给出明确错误，重新拼版后旧补印结果自动清空。
14. 点击「下载拼版 PDF」保存（分册签帖模式也是单个文件，按帖序连续输出），文件名自动在原文件名后加 `-拼版` 后缀。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/preflight` | multipart 表单字段 `pdf` 上传 PDF；**只做印前校验，不生成拼版文件**，返回 JSON 报告（HTTP 200，即使报告含错误级问题）。缺字段/非 PDF 返回 `400`；损坏或加密 PDF 返回 `422` |
| `POST` | `/api/preflight/batch` | multipart 表单字段 `pdfs` 一次上传 **1～10 个 PDF**；按上传顺序逐个复用单文件校验，单个文件缺失/为空、非 PDF、损坏或加密只在该文件结果中记录失败原因（`status: "failed"` + `errorCode`），**不阻断其他文件**，整体仍返回 `200`。响应含每个文件的检测状态与错误/警告/提示数量、按问题代码汇总、**交付放行策略快照与逐文件/整批放行判定**。可选字段 `releasePolicy` 为 JSON 对象（或 JSON 字符串）`{ 问题代码: "block"|"warn"|"ignore" }`，只写需要覆盖默认的代码；未上传任何文件或超过 10 个返回 `400`；策略含未知代码/非法处置/非法 JSON 返回 `400`；单文件超限返回 `413` |
| `POST` | `/api/preflight/diff` | multipart 表单字段 `baseline`（基准 PDF）与 `delivery`（待交付 PDF）各上传一个 PDF；分别复用逐页校验后按「页码 + 问题代码」对齐，返回差异 JSON（新增/已解决/仍存在问题、页数变化、页级明细）。缺任一字段或文件非 PDF 返回 `400`；任一 PDF 损坏/加密返回 `422`（错误信息标明是哪一份） |
| `POST` | `/api/impose` | multipart 表单字段 `pdf` 上传 PDF；返回拼版 PDF，页序方案在响应头 `X-Imposition-Plan`（URL 编码的 JSON，含 `panel` 统一面板尺寸与方向、`sheet` 实际输出印张宽高、`marks` 定位标记状态、`creep` 爬移补偿状态与每张纸的 `creep.shiftMm`）。可选字段：`signatureMode=on` 启用分册签帖，`maxSheetsPerSignature` 为每帖最多纸张数（1～20 整数；启用时必填，非法值返回 `400`）；`registrationMarks=on` 启用印张定位标记（版心四周各加 8 mm 空白并绘制裁切线/折线定位线，整册与签帖均适用；缺省/未勾选时输出尺寸、页序与报价结果保持原样）；`creepCompensation=on` 启用骑马钉爬移补偿，`paperThicknessMm` 为纸厚（0.05～0.5 mm 数值；启用时必填，非法值返回 `400`），启用后左页向右、右页向左平移（张号－1）×纸厚并在各自半区裁切，页序与纸张尺寸不变 |
| `POST` | `/api/quote` | JSON body `{ plan, papers }`：`plan` 为 `/api/impose` 响应头 `X-Imposition-Plan` 解码后的拼版方案（整册/签帖均可），`papers` 为 1～8 种纸张规格 `{ name?, widthMm, heightMm, pricePerSheet, setupFee }`（宽高为正数 mm；单价元/张、开机费元/次，非负；数字字符串也接受）。返回用纸报价 JSON：枚举每种纸张原向与旋转 90° 的容纳情况与成本，`selected` 为最低总价方案。参数非法返回 `400`；**无纸张可容纳时返回 `200` 且 `feasible: false`**，原因在 `reason` 与各选项 `reasons` |
| `POST` | `/api/cutting` | JSON body `{ plan, papers, requiredSheets }`：`plan`/`papers` 同 `/api/quote`；`requiredSheets` 为所需印张数（1～1000000 的整数，数字字符串也接受）。沿用 `plan.sheet` 实际输出印张尺寸，对每种原纸以**带记忆化的矩形分割搜索**生成**直线贯通裁切树**（印张可旋转 90°，非面积估算/非重叠），返回每种原纸的裁切图坐标与裁切树、单张产出 `yieldsPerSheet`、所需原纸张数 `sheetsRequired`、尾张余量 `lastSheet`、废料面积 `waste`，并按所需张数、废料面积给出 `recommended`。参数非法（尺寸非正/数量非整数等）返回 `400`；**无原纸可裁时返回 `200` 且 `feasible: false`**，原因在 `reason` 与各选项 `reasons` |
| `POST` | `/api/reprint` | multipart 表单字段 `pdf` 上传原 PDF、`pages` 为受损原稿页码表达式（如 `2,5-7`，逗号分隔单页/区间，支持全角逗号与全角区间号）；拼版选项字段与 `/api/impose` 相同（`signatureMode`/`maxSheetsPerSignature`/`registrationMarks`/`creepCompensation`/`paperThicknessMm`）。服务端复用拼版方案定位受损页所在印张（同一印张命中多页只补印一次，分册模式累计各帖输出页偏移），按原印张顺序成对抽取正背面生成补印 PDF（与完整拼版对应印张逐页一致：保留原印张尺寸、定位标记与爬移平移/半区裁切），补印明细在响应头 `X-Reprint-Plan`（URL 编码的 JSON，含受损页码 `pages`、补印张数 `sheetCount`、`creep` 补偿状态与每张纸的帖号 `signature`/帖内张号 `sheet`/命中页码 `hitPages`/原输出页码 `outputPages`/单侧内移量 `creepShiftMm`）。缺文件/非 PDF/空输入/格式错误/越界页码/非法纸厚返回 `400`；损坏或加密 PDF 返回 `422` |
| `GET` | `/api/health` | 健康检查，返回 `{ "ok": true }` |

### 印前校验 JSON 报告结构

```jsonc
{
  "schemaVersion": 1,
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-22T16:40:01.471Z",
  "file": { "name": "sample.pdf", "sizeBytes": 12345 },
  "pageCount": 7,
  "referenceSize": { "width": 595.3, "height": 841.9, "widthMm": 210, "heightMm": 297, "pageCount": 6 },
  "summary": {
    "error": 1, "warning": 2, "info": 2,
    "issuesTotal": 5, "pagesWithIssues": 4,
    "passed": false            // 仅当没有错误级问题时为 true
  },
  "issues": [
    {
      "code": "rotated_90_270",
      "severity": "warning",  // error / warning / info
      "title": "页面带 90°/270° 旋转角",
      "pageFrom": 2, "pageTo": 3, "pageCount": 2, "pages": [2, 3],
      "message": "第 2～3 页带 /Rotate 页面旋转（共 2 页）……",
      "values": [{ "label": "旋转角", "value": "90°（第 2～3 页）" }],
      "detected": [{ "page": 2, "detail": "90°" }, { "page": 3, "detail": "90°" }],
      "advice": "如非有意横版，请在源文档中固化/移除页面旋转……"
    }
    // 文档级问题（如 blank_padding）：pageFrom/pageTo/pageCount 为 null，pages 为 []
  ],
  "pages": [
    {
      "page": 1,
      "mediaWidth": 595.3, "mediaHeight": 841.9,
      "effectiveWidth": 595.3, "effectiveHeight": 841.9,
      "widthMm": 210, "heightMm": 297,
      "rotation": 0,
      "transparent": false,
      "textExtractable": true,   // true / false / null（无法判定）
      "issues": [{ "code": "...", "severity": "...", "title": "..." }]
    }
  ]
}
```

问题排序固定为：错误 → 警告 → 提示；同级按起始页码升序，文档级问题排在该级最后。问题代码（`code`）与严重级别语义保持稳定，便于外部脚本消费下载的 JSON。

### 批量校验 JSON 结构（`/api/preflight/batch`）

```jsonc
{
  "schemaVersion": 1,
  "kind": "preflight-batch",
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-23T10:00:00.000Z",
  "limit": 10,
  "releasePolicy": {            // 当次生效的交付放行策略快照
    "defaults": { "error": "block", "warning": "warn", "info": "ignore" },
    "custom": { "rotated_180": "ignore" },  // 请求中显式覆盖的代码（无覆盖时为 {}）
    "rules": [                  // 全部已知代码的最终规则（错误 → 警告 → 提示 → code 排序）
      { "code": "rotated_180", "severity": "error",
        "title": "页面带 180° 旋转（上下颠倒）",
        "action": "ignore", "source": "custom" },   // source: custom（自定义）/ default（按级别默认）
      { "code": "size_mismatch", "severity": "warning",
        "title": "页面尺寸不一致", "action": "warn", "source": "default" }
      // ……共全部 6 个代码
    ]
  },
  "summary": {
    "total": 3,          // 本次提交的文件数
    "completed": 2,      // 成功完成校验的文件数
    "failed": 1,         // 无法校验的文件数（缺失/非 PDF/损坏/加密）
    "passed": 1,         // 成功文件中无错误级问题的文件数（检测维度，含义不变）
    "error": 1,          // 全部成功文件的错误级问题总数
    "warning": 0,
    "info": 2,
    "allPassed": false,  // 无失败文件且全部成功文件均无错误级问题时为 true（含义不变）
    "release": {         // 交付放行汇总（与上方检测维度并列，互不替代）
      "blocked": 1,      // 命中阻断代码的文件数
      "review": 0,       // 无阻断但命中需复核代码的文件数
      "passed": 0,       // 完成校验且无阻断/需复核代码的文件数
      "undetermined": 1, // 无法校验（未判定）的文件数
      "decision": "blocked" // blocked > undetermined > review > passed
    }
  },
  "issueTotals": [       // 按问题代码汇总（错误 → 警告 → 提示，同级按 code）
    {
      "code": "rotated_180",
      "severity": "error",
      "title": "页面带 180° 旋转（上下颠倒）",
      "action": "ignore",       // 当次处置：block / warn / ignore
      "actionSource": "custom", // default（按级别默认）/ custom（请求覆盖）
      "count": 2,        // 总次数：同一文件内同一代码计 1 次
      "fileCount": 2,    // 涉及文件数
      "files": [         // 涉及文件（index 为上传顺序，从 0 开始）
        { "index": 0, "name": "a.pdf" },
        { "index": 2, "name": "c.pdf" }
      ]
    }
  ],
  "files": [
    {
      "index": 0,
      "status": "completed",          // completed（成功）/ failed（无法校验）
      "file": { "name": "a.pdf", "sizeBytes": 12345 },
      "pageCount": 5,
      "passed": false,                // 检测维度：仅 status=completed 且无错误级问题时为 true（含义不变）
      "errorCode": null,
      "error": null,
      "counts": { "error": 1, "warning": 0, "info": 1,
                  "issuesTotal": 2, "pagesWithIssues": 1 },
      "release": {                    // 交付放行判定
        "decision": "passed",         // blocked / review / passed（failed 文件恒为 undetermined）
        "actionCounts": { "block": 0, "warn": 0, "ignore": 2 }, // 触发代码按处置的种数
        "triggered": [                // 触发的代码及处置（阻断 → 警告 → 忽略 → 级别 → code 排序）
          { "code": "blank_padding", "severity": "info",
            "title": "页数不是 4 的倍数，拼版将补空白页",
            "count": 1,               // 该代码在本文件中的区段/文档级问题条数
            "action": "ignore", "source": "default" }
        ]
      },
      "report": { /* 与 /api/preflight 完全一致的完整单文件报告 */ }
    },
    {
      "index": 1,
      "status": "failed",
      "file": { "name": "locked.pdf", "sizeBytes": 8888 },
      "pageCount": null,
      "passed": false,
      "errorCode": "encrypted_pdf",   // not_pdf / invalid_pdf / encrypted_pdf / empty_document
      "error": "PDF 已加密，无法进行印前校验",
      "counts": { "error": 0, "warning": 0, "info": 0, "issuesTotal": 0, "pagesWithIssues": 0 },
      "release": { "decision": "undetermined",
                   "actionCounts": { "block": 0, "warn": 0, "ignore": 0 }, "triggered": [] },
      "report": null
    }
  ]
}
```

说明：

- 结果数组 `files` 严格按上传顺序排列（`index` 从 0 开始）；某个文件失败时其余文件仍正常返回，HTTP 始终为 `200`（除非批量请求本身不合法：未上传文件或超过 10 个 → `400`，`releasePolicy` 含未知代码/非法处置/非法 JSON → `400`，单文件超过大小上限 → `413`）。
- `counts` 统计**区段数**：同一文件内相邻页的同类问题在单文件报告中已合并为一个区段，故同一代码在一个文件中最多计 1 次，`issueTotals[].count` 即该代码在各文件中计得次数之和。
- 放行判定为**新增字段**：`releasePolicy`、`summary.release`、`files[].release` 与 `issueTotals[].action/actionSource` 均不改变或删除任何既有字段；文件级 `passed` 与 `summary.allPassed` 始终是检测维度结论（无错误级问题），与放行维度的 `decision` 独立。
- `releasePolicy` 请求字段为可选，缺省（空对象 `{}` 等价）时全部代码按级别取默认处置（错误阻断、警告需复核、提示忽略）。

### 差异对比 JSON 结构（`/api/preflight/diff`）

```jsonc
{
  "schemaVersion": 1,
  "kind": "preflight-diff",
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-22T17:05:11.123Z",
  "baseline": { "file": { "name": "v3.pdf", "sizeBytes": 12345 }, "pageCount": 5,
                "passed": false, "issuesTotal": 2 },
  "delivery": { "file": { "name": "v4.pdf", "sizeBytes": 12890 }, "pageCount": 8,
                "passed": true, "issuesTotal": 0 },
  "pageCount": {
    "baseline": 5, "delivery": 8, "delta": 3,
    "addedPages": [6, 7, 8],       // 尾部超出基准的页码
    "removedPages": []             // 基准尾部超出待交付的页码
  },
  "summary": {
    "added":      { "error": 1, "warning": 0, "info": 0, "total": 1, "codes": 1 }, // 按问题实例（页）计
    "resolved":   { "error": 0, "warning": 1, "info": 2, "total": 3, "codes": 3 }, // 文档级问题各计 1 项
    "persistent": { "error": 0, "warning": 1, "info": 0, "total": 2, "codes": 1 },
    "addedPages": 3, "removedPages": 0,
    "pagesWithAddedIssues": 1, "pagesWithResolvedIssues": 1, "pagesWithPersistentIssues": 1
  },
  // added / resolved / persistent 结构相同；逐页条目：
  "added": [
    {
      "code": "rotated_180", "severity": "error", "title": "页面带 180° 旋转（上下颠倒）",
      "documentLevel": false,
      "pages": [6], "pageCount": 1,
      "baselineDetails": [],
      "deliveryDetails": [{ "page": 6, "detail": "180°" }],
      "detailChangedPages": [],
      "advice": "请在源文档中移除该页 /Rotate ……"
    }
  ],
  "resolved": [ /* 同上，baselineDetails 有值、deliveryDetails 为空 */ ],
  "persistent": [
    // 同页同代码两侧都有；检测值变化的页码进入 detailChangedPages；
    // 文档级条目 documentLevel=true，改用 baselineDetail/deliveryDetail（字符串）与 detailChanged
  ],
  "pages": [
    {
      "page": 5,
      "status": "retained",          // added（新增页）/ removed（移除页）/ retained（保留页）
      "baseline": { "mediaWidth": 300, "mediaHeight": 400, "widthMm": 105.8, "heightMm": 141.1,
                    "rotation": 0, "transparent": false, "textExtractable": false },
      "delivery": { "mediaWidth": 595.3, "mediaHeight": 841.9, "widthMm": 210, "heightMm": 297,
                    "rotation": 0, "transparent": false, "textExtractable": true },
      "changes": { "sizeChanged": true, "rotationChanged": false,
                   "transparencyChanged": false, "textChanged": true },
      "issues": {
        "added": ["transparency"],  // 该页新增的问题代码
        "resolved": ["size_mismatch", "no_extractable_text"], // 该页已解决的问题代码
        "persistent": []            // 该页仍存在的问题代码
      }
    }
  ]
}
```

说明：

- `added`/`resolved`/`persistent` 三个分组中的条目均按 严重级别（错误 → 警告 → 提示）→ 问题代码 排序；同一代码可在多个分组出现（各自只含对应页码）。
- 任一方文字可提取性为「无法判定」（`null`）时，`changes.textChanged` 不标记为变化，避免把未知状态误报为差异。

### 拼版方案头

`X-Imposition-Plan` 结构：

- 整册模式（未启用签帖）：`{ sheets, sourceCount, paddedCount, totalCount, blanks, panel, sheet, marks, creep }`，页序部分与旧版完全一致。
- 分册签帖模式：`{ signatureMode: true, signatures: [{ signature, startPage, endPage, sourceCount, blanks, totalCount, sheets: [...] }], sourceCount, paddedCount, sheetCount, signatureCount, maxSheetsPerSignature, panel, sheet, marks, creep }`；各 `sheets` 槽位中的 `page` 为全局（整篇文档）页号，`sheet` 为帖内纸张编号。
- 两种模式均含：`sheet = { width, height }` 为**实际输出印张宽高**（pt，启用定位标记时含四周各 8 mm 空白，否则为 `2 × 面板宽` × `面板高`）；`marks = { enabled, marginMm }` 为定位标记状态（未启用时 `enabled: false, marginMm: 0`）；`creep = { enabled, paperThicknessMm }` 为爬移补偿状态（未启用时 `enabled: false, paperThicknessMm: 0`）。启用爬移时每张纸另带 `creep.shiftMm`（该帖帖内张号对应的单侧内移量＝（张号－1）×纸厚，分册签帖各帖分别从零计算；未启用时不含该字段）。三者为新增字段，旧消费方不受影响。

### 补印明细头

`X-Reprint-Plan` 结构（`/api/reprint` 响应头，URL 编码的 JSON）：

```jsonc
{
  "schemaVersion": 1,
  "kind": "reprint-plan",
  "tool": "booklet-imposer",
  "pages": [2, 5, 6, 7],     // 受损原稿页码（升序去重）
  "sheetCount": 2,           // 补印纸张数（同一印张命中多页只计一次）
  "pageCount": 4,            // 补印 PDF 页数 = 2 × sheetCount（正背成对）
  "signatureMode": false,
  "creep": { "enabled": true, "paperThicknessMm": 0.1 },  // 沿用本次爬移补偿状态
  "sheets": [
    {
      "signature": null,             // 帖号（整册模式为 null）
      "sheet": 1,                    // 帖内张号（整册模式即全册张号）
      "signatureSheetCount": null,   // 该帖总张数（整册模式为 null）
      "hitPages": [2],               // 该印张命中的受损页码
      "outputPages": [1, 2],         // 在完整拼版输出中的 1 基页码（正面、背面）
      "creepShiftMm": 0              // 该印张的单侧内移量（（帖内张号－1）×纸厚；未启用爬移时为 0）
    },
    { "signature": null, "sheet": 3, "signatureSheetCount": null,
      "hitPages": [5, 6, 7], "outputPages": [5, 6], "creepShiftMm": 0.2 }
  ]
}
```

补印 PDF 的页序与 `sheets` 一致：每张纸先正面后背面，页尺寸与完整拼版输出完全相同（含定位标记与爬移补偿的平移/半区裁切）。

### 用纸报价 JSON 结构（`/api/quote`）

请求：

```jsonc
{
  "plan": { "sheets": [{ "sheet": 1 }], "panel": { "width": 595.28, "height": 841.89, "orientation": "portrait" } },
  "papers": [
    { "name": "A3 铜版", "widthMm": 420, "heightMm": 297, "pricePerSheet": 0.8, "setupFee": 50 }
  ]
}
```

响应（可行）：

```jsonc
{
  "schemaVersion": 1,
  "kind": "paper-quote",
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-22T18:00:00.000Z",
  "feasible": true,
  "layout": {
    "signatureMode": false, "signatureCount": null,
    "sheetCount": 2, "runCount": 1,        // 分册签帖模式 runCount = 帖数
    "panel": { "widthPt": 595.2756, "heightPt": 841.8898, "widthMm": 210, "heightMm": 297, "orientation": "portrait" },
    "sheet": { "widthPt": 1190.5512, "heightPt": 841.8898, "widthMm": 420, "heightMm": 297 }
                                            // 实际输出印张宽高；启用定位标记时含四周各 8 mm 空白
                                            // （如 436 × 313 mm），报价的容纳判定与利用率均按此计算
  },
  "options": [
    {
      "index": 0,
      "name": "A3 铜版",
      "paper": { "name": "A3 铜版", "widthMm": 420, "heightMm": 297, "widthPt": 1190.55, "heightPt": 841.89,
                 "pricePerSheet": 0.8, "setupFee": 50 },
      "fits": true,
      "placement": {
        "rotated": false, "orientation": "as_is",   // as_is / rotated_90
        "paperWidthUsedMm": 420, "paperHeightUsedMm": 297,
        "slackWidthMm": 0, "slackHeightMm": 0       // 摆放后空余（旋转时以占用方向计算）
      },
      "utilization": 1,        // 印张版面面积 / 纸张面积（4 位小数）
      "utilizationPercent": 100,
      "sheetCount": 2, "runCount": 1,
      "paperCost": 1.6,        // 单价 × 纸张数
      "setupCost": 50,         // 开机费 × 开机次数
      "totalCost": 51.6
    }
  ],
  "selected": { /* options 中总价最低的同构对象 */ }
}
```

无纸张可容纳时（HTTP 200）：`feasible: false`、`selected: null`、`reasonCode: "no_fitting_paper"`，`reason` 为汇总说明；每个不可行选项 `fits: false`，其 `reasons` 给出两个方向的不足量：

```jsonc
{
  "fits": false,
  "reasons": [
    { "orientation": "as_is", "fits": false, "shortageWidthMm": 123, "shortageHeightMm": 87,
      "message": "纸张原向宽度不足 123 mm、高度不足 87 mm" },
    { "orientation": "rotated_90", "fits": false, "shortageWidthMm": 210, "shortageHeightMm": 0,
      "message": "纸张旋转 90° 后宽度不足 210 mm" }
  ],
  "reason": "纸张「A4」（297 × 210 mm）无法容纳版面展开 420 × 297 mm：…"
}
```

说明：

- 金额按**单价 × 数量后四舍五入到分（2 位小数）**再加总；`utilization` 保留 4 位小数、`utilizationPercent` 保留 2 位。
- 选优排序固定为：总价升序 → 利用率降序 → 纸张面积升序 → 维护顺序（`index`）。
- 前端下载的 JSON 在上述结构上额外带 `chosenPaperIndex`，并把 `selected` 替换为用户在页面上手动切换后的方案（未切换时与服务端选优一致）。

### 批量裁切下料 JSON 结构（`/api/cutting`）

请求：

```jsonc
{
  "plan": { "sheets": [{ "sheet": 1 }], "panel": { "width": 595.28, "height": 841.89 },
            "sheet": { "width": 1190.55, "height": 841.89 } },
  "papers": [
    { "name": "大度对开", "widthMm": 889, "heightMm": 1194, "pricePerSheet": 2, "setupFee": 0 }
  ],
  "requiredSheets": 100          // 所需印张数：1～1000000 的整数
}
```

响应（可行；`options` 为维护顺序，`recommended` 指向推荐项）：

```jsonc
{
  "schemaVersion": 1,
  "kind": "sheet-cutting-plan",
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-24T10:00:00.000Z",
  "feasible": true,
  "requiredSheets": 100,
  "layout": {
    "sheetCount": 2, "runCount": 1, "signatureMode": false, "signatureCount": null,
    "panel": { "widthMm": 210, "heightMm": 297, "...": "与 /api/quote 同口径" },
    "sheet": { "widthMm": 420, "heightMm": 297 }   // 沿用 plan.sheet 的实际输出印张尺寸
  },
  "recommended": { "index": 0, "name": "大度对开" },
  "options": [
    {
      "index": 0, "name": "大度对开",
      "paper": { "name": "大度对开", "widthMm": 889, "heightMm": 1194, "pricePerSheet": 2, "setupFee": 0 },
      "feasible": true,
      "yieldsPerSheet": 8,          // 单张原纸可裁出的印张数
      "sheetsRequired": 13,         // = ceil(100 / 8)
      "lastSheet": {
        "isLastSheetPartial": true, // 尾张是否只出一部分（false 时全部出满、无余量）
        "fullSheets": 12,           // 出满的原纸张数
        "lastSheetYield": 4,        // 尾张实际裁出数
        "spareCapacity": 4,         // 尾张尚可再裁的印张数
        "exact": false
      },
      "placement": {
        "rotated": false, "orientation": "as_is",     // 原纸方向：as_is / rotated_90
        "frameWidthMm": 889, "frameHeightMm": 1194,
        "asIsItemCount": 8, "rotatedItemCount": 0     // 印张朝向统计（允许同纸混合旋转）
      },
      "utilization": 0.9401, "utilizationPercent": 94.01,
      "waste": {
        "perSheetAreaMm2": 63545.94,  // 单张原纸废料（裁切树废料叶区域求和）
        "lastSheetAreaMm2": 594278.94,// 尾张废料（含未用的 4 个位）
        "totalAreaMm2": 1357830.22    // 全部投用原纸的总废料
      },
      "cutting": {
        "frame": { "widthMm": 889, "heightMm": 1194 },
        "item": { "widthMm": 420, "heightMm": 297 },
        "cutCount": 7,               // 贯通裁切刀数
        "items": [                   // 印张绝对坐标（mm，原点为原纸左上角）
          { "xMm": 0, "yMm": 0, "widthMm": 420, "heightMm": 297, "rotated": false }
        ],
        "cuts": [                    // 先序即现场裁切顺序，每刀贯通其所在料件
          { "direction": "v", "x1Mm": 420, "y1Mm": 0, "x2Mm": 420, "y2Mm": 1194,
            "pieceXMm": 0, "pieceYMm": 0, "pieceWidthMm": 889, "pieceHeightMm": 1194 }
        ],
        "tree": { /* 完整直线贯通裁切树：cut 节点 {kind:'cut',direction,offsetMm,
                     xMm,yMm,widthMm,heightMm,first,second}；
                     leaf 节点 {kind:'leaf',used,rotated,widthMm,heightMm,
                     itemWidthMm,itemHeightMm}，叶矩形无缝铺满原纸 */ }
      }
    }
  ]
}
```

无可行方案时（HTTP 200）：`feasible: false`、`recommended: null`、`reasonCode: "no_fitting_paper"`，每个不可行选项 `feasible: false`，其 `reasons` 给出原向与旋转 90° 两个方向的不足量（结构同 `/api/quote` 的 `reasons`）；单张可裁数量超过 10000 的异常规格组合对应 `reasonCode: "too_many_items"`。

说明：

- 排料由**带记忆化的递归矩形分割搜索**得到（`(剩余宽, 剩余高)` 记忆化，切位只取印张边长整数倍），目标为先最大化印张数、再最小化废料；不是面积除法估算，`items` 坐标可直接校验**互不重叠、不越界**，`cuts` 中每条线都**贯通其所在料件**。
- 推荐排序固定为：所需原纸张数升序 → 总废料面积升序 → 单张产出降序 → 维护顺序（`index`）。
- 裁切图仅消费 `cutting.items` 与 `cutting.cuts`；`tree` 便于外部系统做工艺复核与再加工。

## 目录结构

```
.
├── server.js                # Express 服务：上传、单文件/批量印前校验、差异对比、拼版、缺页补印、用纸报价与批量裁切下料接口
├── lib/impose.js            # 骑马钉页序计算与 pdf-lib 拼版核心（含分册签帖、爬移补偿：逐张内移量、半区矩形裁切）
├── lib/sheet-marks.js       # 印张定位标记：8mm 空白边距、印张尺寸计算、裁切线/折线定位线绘制
├── lib/preflight.js         # 印前校验核心：逐页尺寸/旋转/透明度/文字检查与区段合并
├── lib/preflight-batch.js   # 批量印前校验：顺序复用单文件校验，失败不阻断、按代码汇总、代码级放行策略与逐文件/整批交付放行判定
├── lib/preflight-diff.js    # 差异对比核心：两份校验报告按页码+问题代码对齐
├── lib/quote.js             # 用纸报价核心：纸张规格校验、旋转方向枚举与最低成本选优
├── lib/cutting.js           # 批量裁切下料：记忆化矩形分割（guillotine）搜索、直线贯通裁切树、单张产出/所需原纸/尾张/废料与推荐排序
├── lib/reprint.js           # 缺页补印：页码表达式解析、印张定位（分册累计输出页偏移）、成对抽取正背面生成补印 PDF
├── public/                  # 原生前端（index.html / style.css / app.js）
├── test/                    # 单测与端到端测试（impose / preflight / preflight-diff / quote / cutting / sheet-marks / creep / reprint / HTTP API）
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 测试

```bash
npm test
```

依次运行拼版算法单测、印前校验单测/端到端测试（构造含尺寸不一致、90°/180° 旋转、透明度、无文字页的 PDF，校验区段合并与严重级别）、**批量放行判定测试**（默认处置：错误阻断/警告复核/提示忽略；自定义策略覆盖与非法策略报错；逐文件 blocked/review/passed、无法校验 undetermined、阻断优先于警告；整批 blocked > undetermined > review > passed；策略快照导出；`passed`/`allPassed`/内嵌原报告含义不变）、**差异对比纯函数与端到端测试**（验证逐页按「页码 + 代码」对齐、文档级问题对齐、页数变化与检测值变化）、**用纸报价纯函数测试**（验证版面读取、原向/旋转方向枚举、最低总价选优、利用率与金额计算、分册开机次数、全部不可行的不足量原因）、**批量裁切下料纯函数测试**（所需印张数校验；记忆化矩形分割搜索在整数网格上与暴力 guillotine 解穷举对拍；裁切树叶矩形铺满根矩形、印张互不重叠/不越界/尺寸方向一致、每条裁切线贯通其所在料件；原纸原向/旋转枚举、同纸混合旋转摆放；单张产出、所需原纸张数、尾张余量、单张/尾张/总废料面积；按所需张数与废料面积的推荐排序；不可行的两方向不足量原因与单张数量规模上限）、**印张定位标记测试**（8mm 空白边距与印张尺寸计算、正背面各 10 条标记线全部位于版心之外、源页整体偏移 8mm 且页序不变、分册签帖同样适用、报价按实际印张宽高判定、未启用时输出与报价保持原样）、**骑马钉爬移补偿测试**（纸厚 0.05～0.5 mm 解析与非法值报错；单侧内移量＝（帖内张号－1）×纸厚、分册签帖各帖分别从零计算；端到端正背两面左页右移/右页左移、半区矩形裁剪位置、补白不绘制不裁剪、页序/纸张尺寸/用纸数不变、与定位标记叠加、未启用时输出逐字节一致；补印沿用本次纸厚与选项、与完整拼版对应印张逐页一致；HTTP 接口字段透传、非法/缺失纸厚 `400`）、**缺页补印测试**（页码表达式解析：空输入/格式错误/越界页码的明确错误与去重升序；印张定位：同一印张命中多页只补印一次、分册模式累计各帖输出页偏移；端到端补印：整册/分册/启用定位标记三种选项下按原印张顺序成对抽取正背面，补印页与完整拼版输出页逐页内容一致、印张尺寸保留）以及 HTTP 接口集成测试（验证校验报告含错误时拼版仍可成功，二者互不阻断；差异接口缺字段 `400`、非 PDF `400`、基准/待交付损坏分别 `422`；批量接口混合文件整体 `200` 且逐文件标记检测状态与放行判定、自定义放行策略 `200` 且非法策略 `400`；报价接口选优与不可行返回 `200`、参数非法 `400`、非法 JSON `400`；裁切接口可行方案的产出/所需张数/尾张/裁切坐标、全部不可行返回 `200`、缺 plan/papers/数量非法返回 `400`；`registrationMarks=on` 输出加大并记录实际印张宽高、报价与裁切按该宽高计算，未勾选时方案与报价结果保持原样；补印接口命中定位与成对抽取 `200`、同一印张只补一次、分册输出页偏移、定位标记尺寸保留，空输入/格式错误/越界 `400`、缺文件/非 PDF `400`、损坏 PDF `422`）。测试不依赖 Docker，也不监听固定端口。
