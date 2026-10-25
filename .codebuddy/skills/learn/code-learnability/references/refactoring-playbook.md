# 重构手法手册（refactoring-playbook）

> 六个手法按优先级排列，逐条对照目标代码套用。示例为通用 Python 伪代码，
> 手法本身与语言无关。所有手法共享同一前提：**行为等价、最小改动、验证先行**。

## 手法 1：一个函数一个用途（Single Purpose）

判断标准：**这个函数能不能用一句话（不带"和/然后"）说清它干什么？**
说不清就拆。拆法：把"干什么"切成几段互斥的职责，每段提成一个新函数。

```python
# ── Before：一个函数干三件事（读数据 + 算结果 + 写文件），读的人要全看完才知道边界 ──
def process(path):
    rows = [json.loads(l) for l in open(path)]          # 职责A：读
    total = sum(r["score"] * r["weight"] for r in rows) # 职责B：算
    open(path + ".out", "w").write(str(total))          # 职责C：写

# ── After：一个函数一个用途，主函数读起来像目录 ──
def process(path):
    rows = load_rows(path)              # A：读数据（可独立测试/复用）
    total = weighted_total(rows)        # B：算结果（规则变化只改这里）
    write_result(path, total)           # C：写输出（IO 细节被隔离）
```

结果：每个函数都能被单独读懂、单独测试、单独复用；主函数成了"目录页"。

## 手法 2：公共逻辑抽取复用（DRY）

同一逻辑出现 ≥2 次（或"复制改了个别常量"）时，抽成一个函数，差异做成参数。

```python
# ── Before：两处几乎相同的切片循环，改一处漏一处是必然事故 ──
out_a = np.empty(len(feat_a));  out_b = np.empty(len(feat_b))
for s in range(0, len(feat_a), 8192):
    out_a[s:s+8192] = model(feat_a[s:s+8192])
for s in range(0, len(feat_b), 8192):   # 和上面逐字相同，只换了数组
    out_b[s:s+8192] = model(feat_b[s:s+8192])

# ── After：差异收敛到参数，批量大小只改一处 ──
def predict_batched(model, feat, batch=8192):   # 唯一实现，单一事实来源
    out = np.empty(len(feat))
    for s in range(0, len(feat), batch):        # 固定批切片：结果与批组合无关
        out[s:s+batch] = model(feat[s:s+batch])
    return out
```

结果：修 bug / 调参数只改一处；调用方少一行是一行。

## 手法 3：编排与实现分离（点菜式）

把"流程步骤串起来"的编排代码，与"具体怎么算"的实现代码分成两层：
实现放公用模块，编排只做 import + 按顺序调用。这是手法 1/2 的组合应用。

```python
# ── 编排层（薄）：像点菜，一眼看清流程 ──
def run_once(cfg):
    data = collect(cfg)          # 打牌/取数
    buf  = assemble(data)        # 整理格式
    m    = update(buf, cfg)      # 学习一步
    report(m)                    # 记录结果

# ── 实现层（厚）：collect/assemble/update 各自独立模块，被多个编排复用 ──
```

结果：新人先读编排层建立全局感（10 行看完流程），再按需下钻实现层；
换编排不碰实现，改实现不碰编排。

## 手法 4：教学式注释（操作 + 目的）

注释固定两槽位，写在行尾或行上方：
`# 操作：`说明这一行在做什么（面向"看不懂意图"的人）；
`# 结果：`或`# 目的：`说明得到什么、为什么要做（面向"看懂了但不知为何"的人）。

```python
ratio = (new_logp - old_logp).exp()      # 操作：新旧策略给同一动作的概率比
ratio = torch.clamp(ratio, 0.8, 1.2)     # 目的：把单步更新幅度锁在 ±20%，防一步学崩
adv = (adv - adv.mean()) / adv.std()     # 结果：功劳分标准化，两类损失的梯度尺度可比
```

结果：读者逐行都有"在做什么 + 为什么"两个锚点，不需要猜。
注意：注释必须与代码同步更新，过时注释比没注释更害人。

### 4.1 docstring 首行 = 中文定位（函数用途写在自己门口）

函数用途写在**自己的 docstring 首行**，用讲解语气，不在文件头堆速查表（读者悬停/
help 时第一眼看到的就是它）。推荐三段式：

```python
def collect_rollout(args, cur_ckpt, seed_base, iter_no=0, rollout_dir=...):
    """一句话定位：采集当代训练数据——让"当前策略"实际打牌，把过程逐行记录到磁盘。

    分步动作（复杂函数才需要）：
      ① 归档上一代旧数据（整体改名，不删除）；
      ② 拉起环境池子进程，多实例并行打牌，逐行写入 rollout 目录；
      ③ 数据闸门校验完整性，不过关即中止训练。

    历史踩坑/参数说明等补充信息放最后，不遮挡主用途。
    """
```

两条反模式（实测被用户打回）：
- **问答式注释**：`# 为什么一开始就保存？因为...` ——改成陈述：`# 采集不在本进程，
  子进程只认磁盘上的 ckpt 文件，因此先落盘再采集`；
- **模块头速查表**：把所有函数用途列成大表放文件头 ——表格会过时，用途应写在
  各函数 docstring 首行，模块 docstring 只留一段话总体定位。

## 手法 5：段落长度纪律（段 5~10 行，函数 ≤50 行）

函数主体超过 10 行时，按"做完整的一小步"切一段，每段提成函数或用空行+注释分组。
每段必须能被一句话概括；概括不出来 = 这段混了两个用途，回手法 1。

**函数硬上限 50 行（含 docstring）**：到线必须拆。常用拆法：双层循环拆出内层
（"代循环编排"与"单批计算"分层）、准备与执行分离、分支体提成函数。
拆完用 AST 一行脚本量行数验收（NONE = 全过）：

```python
python -c "import ast; src=open('目标.py',encoding='utf-8').read(); t=ast.parse(src); \
fns=[f for c in t.body if isinstance(c,ast.ClassDef) for f in c.body if isinstance(f,ast.FunctionDef)] \
    +[f for f in t.body if isinstance(f,ast.FunctionDef)]; \
print([(f.lineno,f.name,f.end_lineno-f.lineno+1) for f in fns if f.end_lineno-f.lineno+1>50] or 'NONE')"
```

```python
def train_iter(cfg):                      # 主体 8 行 = 4 步，每步一个函数
    ckpt = snapshot(cfg.policy)           # ① 存当前策略快照
    data = collect(cfg, ckpt)             # ② 用快照采集数据
    buf  = prepare(data, cfg)             # ③ 组装+算功劳分
    return update(buf, cfg)               # ④ 更新并返回指标
```

结果：代码评审、讲解、定位都按"段"为单位进行，认知负担恒定。

## 手法 6：命名自解释

名字直接说"干什么"，禁用 do/handle/process 这类空词；布尔用 is/has/can 前缀。

```python
# Before                          # After
def do_data(d):                   def assemble_training_buffer(records)
flag = check(m)                   is_record_complete = validate_manifest(m)
tmp = d[0] * d[1]                 reward = net_gain / big_blind
```

结果：代码自己讲完 80% 的故事，注释只补"为什么"。

## 交付前验证清单

- [ ] 行为等价有证据：测试全绿 / 冒烟脚本输出与重构前一致
- [ ] 每个函数一句话说清用途；主体 ≤10 行（编排函数可放宽到 ~15 行）
- [ ] 函数总长（含 docstring）≤50 行，AST 量行数脚本验收为 NONE
- [ ] 重复逻辑已收敛到唯一实现
- [ ] 注释为"操作+目的"两槽位格式，且与代码同步
- [ ] 未顺手改动任何与可学习性无关的内容（diff 干净）
- [ ] 遵守了目标项目的分层与命名规范
