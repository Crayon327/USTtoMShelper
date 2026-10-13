#target aftereffects
#targetengine "USTtoMShelper"

/*
 * USTtoMShelper - 口型样板、UST 解析与时间重映射
 * v0.6.0
 * 创建 7 秒口型样板，解析传统 UST，并根据日语元音生成时间重映射。
 * 可放入 Scripts/ScriptUI Panels 作为面板运行，也可通过“运行脚本文件”运行。
 */
(function (thisObj) {
    var SCRIPT_NAME = "USTtoMShelper";
    var PANEL_TITLE = "USTtoMShelper - 口型辅助";

    // 样板合成参数；后续时间重映射根据这些固定标记定位口型。
    var TEMPLATE_DURATION = 7.0;
    var FRAME_RATE = 30.0;
    var PIXEL_ASPECT = 1.0;
    var VOWEL_SEGMENT_DURATION = 1.0;
    var CLOSING_SEGMENT_DURATION = 0.5;
    var TICKS_PER_QUARTER = 480.0;
    var DEFAULT_BPM = 120.0;

    function trimText(value) {
        return String(value).replace(/^\s+|\s+$/g, "");
    }

    function isValidDimension(value) {
        return !isNaN(value) && value >= 4 && value <= 30000 && Math.floor(value) === value;
    }

    function frameTime(seconds) {
        return Math.round(seconds * FRAME_RATE) / FRAME_RATE;
    }

    function addCompMarker(comp, time, name) {
        comp.markerProperty.setValueAtTime(frameTime(time), new MarkerValue(name));
    }

    function createTemplate(width, height) {
        var tA = 0.0;
        var tI = frameTime(tA + VOWEL_SEGMENT_DURATION);
        var tU = frameTime(tI + VOWEL_SEGMENT_DURATION);
        var tE = frameTime(tU + VOWEL_SEGMENT_DURATION);
        var tO = frameTime(tE + VOWEL_SEGMENT_DURATION);
        var tOEnd = frameTime(tO + VOWEL_SEGMENT_DURATION);
        var tClosed = frameTime(tOEnd + CLOSING_SEGMENT_DURATION);

        if (tClosed >= TEMPLATE_DURATION) {
            throw new Error("闭口标记必须位于合成结束之前。");
        }

        var compName = "USTtoMShelper_Lip_" + width + "x" + height;
        var comp = app.project.items.addComp(
            compName, width, height, PIXEL_ASPECT, TEMPLATE_DURATION, FRAME_RATE
        );

        // 添加 7 个状态/边界标记。
        addCompMarker(comp, tA, "a");
        addCompMarker(comp, tI, "i");
        addCompMarker(comp, tU, "u");
        addCompMarker(comp, tE, "e");
        addCompMarker(comp, tO, "o");
        addCompMarker(comp, tOEnd, "o-end");
        addCompMarker(comp, tClosed, "closed");

        // 每段中点作为长音维持位置。
        addCompMarker(comp, (tA + tI) / 2, "a-hold");
        addCompMarker(comp, (tI + tU) / 2, "i-hold");
        addCompMarker(comp, (tU + tE) / 2, "u-hold");
        addCompMarker(comp, (tE + tO) / 2, "e-hold");
        addCompMarker(comp, (tO + tOEnd) / 2, "o-hold");

        comp.openInViewer();
        return comp;
    }

    // ---- UST 文件读取 ----------------------------------------------------

    // 根据用户选择、BOM 与 Charset 声明决定 UST 的读取编码。
    function detectUSTEncoding(rawText, encodingMode) {
        if (encodingMode === 1) {
            return "UTF-8";
        }
        if (encodingMode === 2) {
            return "Shift_JIS";
        }

        // 存在 UTF-8 BOM 或 Charset 声明时，优先使用文件声明的编码。
        if (rawText.length >= 3 && rawText.charCodeAt(0) === 239 &&
            rawText.charCodeAt(1) === 187 && rawText.charCodeAt(2) === 191) {
            return "UTF-8";
        }
        var header = rawText.substring(0, Math.min(rawText.length, 8192));
        if (/Charset\s*=\s*["']?UTF-?8/i.test(header)) {
            return "UTF-8";
        }
        if (/Charset\s*=\s*["']?(Shift[_-]?JIS|SJIS)/i.test(header)) {
            return "Shift_JIS";
        }

        // 未声明编码时，传统 UST 默认按 Shift-JIS 读取。
        return "Shift_JIS";
    }

    // 先以二进制方式检查文件头，再按选定编码读取文本。
    function readUSTFile(ustFile, encodingMode) {
        var rawFile = new File(ustFile.fsName);
        rawFile.encoding = "BINARY";
        if (!rawFile.open("r")) {
            throw new Error("无法读取 UST 文件：" + ustFile.fsName);
        }
        var rawText = rawFile.read();
        rawFile.close();

        var encoding = detectUSTEncoding(rawText, encodingMode);
        var textFile = new File(ustFile.fsName);
        textFile.encoding = encoding;
        if (!textFile.open("r")) {
            throw new Error("无法以 " + encoding + " 编码打开 UST 文件。");
        }
        var text = textFile.read();
        textFile.close();
        text = text.replace(/^\uFEFF/, "");

        return { text: text, encoding: encoding };
    }

    // ---- 日语元音识别 ----------------------------------------------------

    var kanaVowel = {};

    function mapKanaGroup(vowel, chars) {
        var i;
        for (i = 0; i < chars.length; i++) {
            kanaVowel[chars.charAt(i)] = vowel;
        }
    }

    mapKanaGroup("a", "あかがさざただなはばぱまゃやらわぁゎゕ");
    mapKanaGroup("i", "いきぎしじちぢにひびぴみりゐぃ");
    mapKanaGroup("u", "うくぐすずつづぬふぶぷむゅゆるゔぅ");
    mapKanaGroup("e", "えけげせぜてでねへべぺめれゑぇゖ");
    mapKanaGroup("o", "おこごそぞとどのほぼぽもょよろをぉ");

    function toHiraganaChar(ch) {
        var code = ch.charCodeAt(0);
        if (code >= 0x30A1 && code <= 0x30F6) {
            return String.fromCharCode(code - 0x60);
        }
        return ch;
    }

    // 将歌词归类为 a/i/u/e/o、closed 或 unknown；本版不分析辅音。
    function classifyLyric(lyric, previousVowel) {
        var original = trimText(lyric);
        var lower = original.toLowerCase();
        var tokens, lastToken, i, ch, hira, found = "", vowel;

        if (original === "" || /^(r|rest|sil|silence|pau|sp|cl|br)$/i.test(original)) {
            return { vowel: "closed", kind: "rest", recognized: true };
        }
        if (/^(っ|ッ)$/.test(original)) {
            return { vowel: "closed", kind: "closure", recognized: true };
        }
        if (/^(ん|ン|n)$/i.test(original)) {
            return { vowel: "closed", kind: "closure", recognized: true };
        }
        if (/^(ー|ｰ)+$/.test(original)) {
            if (previousVowel && /^[aiueo]$/.test(previousVowel)) {
                return { vowel: previousVowel, kind: "long", recognized: true };
            }
            return { vowel: "unknown", kind: "unknown", recognized: false };
        }

        // 按歌词中最后一个可识别假名判断元音，可处理「きゃ」「しゅ」「てぃ」等拗音组合。
        // 片假名会先转换为平假名再进行识别。
        for (i = 0; i < original.length; i++) {
            ch = original.charAt(i);
            hira = toHiraganaChar(ch);
            if (hira === "ん") {
                found = "closed";
            } else if (hira === "っ") {
                found = "closed";
            } else if (kanaVowel[hira]) {
                found = kanaVowel[hira];
            }
        }
        if (/^[aiueo]$/.test(found)) {
            return { vowel: found, kind: "kana", recognized: true };
        }
        if (found === "closed") {
            return { vowel: "closed", kind: "closure", recognized: true };
        }

        // 无法识别假名时，尝试按常见罗马字别名的末尾元音判断。
        // 无法判断的别名保留为 unknown，供后续手动映射。
        tokens = lower.split(/\s+/);
        lastToken = tokens[tokens.length - 1];
        if (/^(r|rest|sil|silence|pau|sp|cl|br|n)$/.test(lastToken)) {
            return { vowel: "closed", kind: "rest", recognized: true };
        }
        var romanMatch = lastToken.match(/[aiueo]$/);
        if (romanMatch) {
            vowel = romanMatch[0];
            return { vowel: vowel, kind: "alias", recognized: true };
        }
        return { vowel: "unknown", kind: "unknown", recognized: false };
    }

    // ---- UST 解析与时间计算 ----------------------------------------------

    // 读取音符区段，累计 Length 与 Tempo，得到每个音符的起止时间。
    function parseUSTText(text) {
        var lines = text.split(/\r\n|\n|\r/);
        var sections = [];
        var current = null;
        var i, line, headerMatch, equalPos, key, value, section, setting;
        var notes = [];
        var warnings = [];

        for (i = 0; i < lines.length; i++) {
            line = trimText(lines[i]);
            if (!line || line.charAt(0) === ";") {
                continue;
            }
            headerMatch = line.match(/^\[#([^\]]+)\]$/);
            if (headerMatch) {
                current = { name: trimText(headerMatch[1]), props: {} };
                sections.push(current);
                continue;
            }
            if (!current) {
                continue;
            }
            equalPos = line.indexOf("=");
            if (equalPos <= 0) {
                continue;
            }
            key = trimText(line.substring(0, equalPos)).toLowerCase();
            value = trimText(line.substring(equalPos + 1));
            current.props[key] = value;
        }

        setting = null;
        for (i = 0; i < sections.length; i++) {
            if (sections[i].name.toUpperCase() === "SETTING") {
                setting = sections[i];
                break;
            }
        }

        var tempo = DEFAULT_BPM;
        if (setting && setting.props.tempo !== undefined && setting.props.tempo !== "") {
            var settingTempo = parseFloat(setting.props.tempo);
            if (!isNaN(settingTempo) && settingTempo > 0) {
                tempo = settingTempo;
            } else {
                warnings.push("[#SETTING] 中的 Tempo 无效，已使用默认 " + DEFAULT_BPM + " BPM。");
            }
        } else {
            warnings.push("未找到全局 Tempo，已使用默认 " + DEFAULT_BPM + " BPM。");
        }

        var noteSections = [];
        for (i = 0; i < sections.length; i++) {
            section = sections[i];
            if (section.name.toUpperCase() === "TRACKEND") {
                break;
            }
            if (/^\d+$/.test(section.name)) {
                section.sortIndex = parseInt(section.name, 10);
                noteSections.push(section);
            }
        }
        noteSections.sort(function (a, b) { return a.sortIndex - b.sortIndex; });

        if (noteSections.length === 0) {
            throw new Error("没有找到传统 UST 音符区段（例如 [#0000]）。请确认选中的是 .ust，而非 .ustx。");
        }

        var tickCursor = 0;
        var secondCursor = 0;
        var previousVowel = "";
        var rawLength, lengthTicks, localTempo, lyric, classified, durationSeconds, endSeconds;
        var noteNumber;

        for (i = 0; i < noteSections.length; i++) {
            section = noteSections[i];
            if (section.props.tempo !== undefined && section.props.tempo !== "") {
                localTempo = parseFloat(section.props.tempo);
                if (!isNaN(localTempo) && localTempo > 0) {
                    tempo = localTempo;
                } else {
                    warnings.push("音符区段 [#" + section.name + "] 的 Tempo 无效，沿用此前速度。");
                }
            }

            rawLength = section.props.length;
            if (rawLength === undefined || rawLength === "") {
                warnings.push("音符区段 [#" + section.name + "] 缺少 Length，已跳过该区段。");
                continue;
            }
            lengthTicks = parseFloat(rawLength);
            if (isNaN(lengthTicks) || lengthTicks <= 0) {
                warnings.push("音符区段 [#" + section.name + "] 的 Length 无效或不大于 0，已跳过。");
                continue;
            }

            lyric = section.props.lyric !== undefined ? section.props.lyric : "";
            classified = classifyLyric(lyric, previousVowel);
            durationSeconds = (lengthTicks / TICKS_PER_QUARTER) * (60.0 / tempo);
            endSeconds = secondCursor + durationSeconds;
            noteNumber = section.props.notenum !== undefined ? section.props.notenum : "";

            notes.push({
                index: notes.length + 1,
                section: section.name,
                startTick: tickCursor,
                endTick: tickCursor + lengthTicks,
                startSeconds: secondCursor,
                endSeconds: endSeconds,
                durationSeconds: durationSeconds,
                bpm: tempo,
                lyric: lyric,
                vowel: classified.vowel,
                kind: classified.kind,
                recognized: classified.recognized,
                noteNumber: noteNumber
            });

            if (/^[aiueo]$/.test(classified.vowel)) {
                previousVowel = classified.vowel;
            } else if (classified.vowel === "closed" || classified.vowel === "unknown") {
                previousVowel = "";
            }

            tickCursor += lengthTicks;
            secondCursor = endSeconds;
        }

        if (notes.length === 0) {
            throw new Error("找到了音符区段，但没有可用的正数 Length 音符。");
        }

        return {
            notes: notes,
            warnings: warnings,
            initialBpm: setting && setting.props.tempo ? parseFloat(setting.props.tempo) : DEFAULT_BPM,
            totalTicks: tickCursor,
            totalSeconds: secondCursor,
            noteSectionsFound: noteSections.length
        };
    }

    function parseUSTFile(file, encodingMode) {
        var readResult = readUSTFile(file, encodingMode);
        var result = parseUSTText(readResult.text);
        result.encoding = readResult.encoding;
        result.fileName = file.name;
        result.counts = { vowels: 0, closed: 0, unknown: 0 };
        var i, vowel;
        for (i = 0; i < result.notes.length; i++) {
            vowel = result.notes[i].vowel;
            if (/^[aiueo]$/.test(vowel)) {
                result.counts.vowels++;
            } else if (vowel === "closed") {
                result.counts.closed++;
            } else {
                result.counts.unknown++;
            }
        }
        return result;
    }

    // ---- 样板标记读取与时间重映射 ------------------------------------------

    function getCompMarkerTime(comp, markerName) {
        var markers = comp.markerProperty;
        var i, marker;
        if (!markers) {
            return null;
        }
        for (i = 1; i <= markers.numKeys; i++) {
            marker = markers.keyValue(i);
            if (marker && marker.comment === markerName) {
                return markers.keyTime(i);
            }
        }
        return null;
    }

    function getTemplateMarkerMap(sourceItem) {
        // 默认时间与样板生成器的标记安排一致。
        // 所选素材没有标记或不是预合成时，仍使用这组固定时间，不阻止应用。
        var found = {
            "a": 0.0,
            "a-hold": 0.5,
            "i": 1.0,
            "i-hold": 1.5,
            "u": 2.0,
            "u-hold": 2.5,
            "e": 3.0,
            "e-hold": 3.5,
            "o": 4.0,
            "o-hold": 4.5,
            "o-end": 5.0,
            "closed": 5.5
        };
        var names = [
            "a", "a-hold", "i", "i-hold", "u", "u-hold",
            "e", "e-hold", "o", "o-hold", "o-end", "closed"
        ];
        var candidate = {};
        var allMarkersFound = sourceItem instanceof CompItem;
        var i, t;

        // 若来源是预合成且含有全部标记，则采用其实际时间；否则保留默认时间。
        if (allMarkersFound) {
            try {
                for (i = 0; i < names.length; i++) {
                    t = getCompMarkerTime(sourceItem, names[i]);
                    if (t === null) {
                        allMarkersFound = false;
                        break;
                    }
                    candidate[names[i]] = t;
                }
            } catch (markerReadError) {
                allMarkersFound = false;
            }
        }

        if (allMarkersFound) {
            // 若标记完整但排列不符合约定，使用默认时间，避免阻止应用。
            var ordered = true;
            var vowelCheck = ["a", "i", "u", "e", "o"];
            for (i = 0; i < vowelCheck.length; i++) {
                var startTime = candidate[vowelCheck[i]];
                var holdTime = candidate[vowelCheck[i] + "-hold"];
                var endTime = (i < vowelCheck.length - 1)
                    ? candidate[vowelCheck[i + 1]] : candidate["o-end"];
                if (!(startTime < holdTime && holdTime < endTime)) {
                    ordered = false;
                    break;
                }
            }
            if (ordered && candidate["o-end"] < candidate.closed) {
                found = candidate;
            }
        }

        var vowelNames = ["a", "i", "u", "e", "o"];
        var map = { start: {}, hold: {}, end: {}, closed: found.closed };
        for (i = 0; i < vowelNames.length; i++) {
            map.start[vowelNames[i]] = found[vowelNames[i]];
            map.hold[vowelNames[i]] = found[vowelNames[i] + "-hold"];
            map.end[vowelNames[i]] = (i < vowelNames.length - 1)
                ? found[vowelNames[i + 1]] : found["o-end"];
        }
        return map;
    }

    function isVowelEvent(note) {
        return /^[aiueo]$/.test(note.vowel);
    }

    function appendRemapKey(keys, time, sourceTime, sourceLabel) {
        var i;
        var epsilon = 0.000001;
        for (i = 0; i < keys.length; i++) {
            if (Math.abs(keys[i].time - time) < epsilon) {
                // 若多个事件落在同一时间点，则使用后出现的事件。
                keys[i].sourceTime = sourceTime;
                keys[i].sourceLabel = sourceLabel;
                return;
            }
        }
        keys.push({ time: time, sourceTime: sourceTime, sourceLabel: sourceLabel });
    }

    // 将 UST 音符转换为外层合成时间与样板源时间之间的关键帧计划。
    function buildTimeRemapPlan(parseResult, layer, parentComp, markerMap) {
        var notes = parseResult.notes;
        var keys = [];
        var warnings = [];
        var frameDuration = parentComp.frameDuration;
        var baseInPoint = layer.inPoint;
        var totalSeconds = parseResult.totalSeconds;
        var requiredOutPoint = baseInPoint + totalSeconds;
        var i, note, nextNote, vowel, sourceBase, sourceStart, sourceHold, sourceEnd;
        var noteStart, noteEnd, noteDuration, endKeyTime, trimsOutgoing;
        var inDistance, outDistance, transitionIn, transitionOut;
        var holdStartTime, holdEndTime, midpoint;
        var tiny = 0.000001;
        var shortNotes = 0;

        if (notes.length === 0 || totalSeconds <= 0) {
            throw new Error("UST 中没有可用于生成口型的有效音符。 ");
        }
        if (requiredOutPoint > parentComp.duration + tiny) {
            throw new Error(
                "当前合成时长不足以容纳这份 UST。\n" +
                "需要结束于 " + requiredOutPoint.toFixed(3) + " 秒，当前合成结束于 " +
                parentComp.duration.toFixed(3) + " 秒。\n请先延长外层合成，再应用口型。"
            );
        }

        for (i = 0; i < notes.length; i++) {
            note = notes[i];
            nextNote = (i + 1 < notes.length) ? notes[i + 1] : null;
            vowel = isVowelEvent(note) ? note.vowel : "closed";
            sourceBase = isVowelEvent(note) ? markerMap.start[vowel] : markerMap.closed;
            noteStart = baseInPoint + note.startSeconds;
            noteEnd = baseInPoint + note.endSeconds;
            noteDuration = noteEnd - noteStart;

            // 第一条音符从对应源时间 +0.25 秒开始；无元音音符从 closed +0.25 秒开始。
            // 其余元音之间的交界从当前元音标记的 0.00 秒位置开始。
            sourceStart = sourceBase + ((i === 0 || !isVowelEvent(note)) ? 0.25 : 0.0);

            trimsOutgoing = nextNote !== null && !isVowelEvent(nextNote);
            if (isVowelEvent(note)) {
                sourceHold = markerMap.hold[vowel];
                sourceEnd = trimsOutgoing ? sourceBase + 0.75 : markerMap.end[vowel];
            } else {
                sourceHold = null;
                sourceEnd = trimsOutgoing ? sourceBase + 0.75 : sourceStart;
            }

            // 除最后一条音符外，出点通常提前一帧，避免交界两侧的源时间冲突。
            // 下一条音符没有元音时，前一元音的出点缩短到该元音段起点 +0.75 秒。
            endKeyTime = noteEnd;
            if (nextNote !== null) {
                var boundaryOffset = Math.min(frameDuration, noteDuration / 2.0);
                if (boundaryOffset > tiny) {
                    endKeyTime = noteEnd - boundaryOffset;
                } else {
                    warnings.push("音符 " + note.section + " 太短，无法完整设置交界出点；已使用边界时刻。");
                }
            }
            if (endKeyTime <= noteStart + tiny) {
                endKeyTime = noteEnd;
                warnings.push("音符 " + note.section + " 的有效时长不足一帧，部分口型转场可能无法显示。");
            }

            appendRemapKey(keys, noteStart, sourceStart, "note-start");

            if (isVowelEvent(note)) {
                noteDuration = endKeyTime - noteStart;
                inDistance = Math.max(0, sourceHold - sourceStart);
                outDistance = Math.max(0, sourceEnd - sourceHold);
                transitionIn = Math.min(inDistance, noteDuration / 2.0);
                transitionOut = Math.min(outDistance, noteDuration / 2.0);
                holdStartTime = noteStart + transitionIn;
                holdEndTime = endKeyTime - transitionOut;

                if (holdStartTime > holdEndTime) {
                    midpoint = (noteStart + endKeyTime) / 2.0;
                    appendRemapKey(keys, midpoint, sourceHold, "vowel-hold");
                } else {
                    appendRemapKey(keys, holdStartTime, sourceHold, "vowel-hold-in");
                    appendRemapKey(keys, holdEndTime, sourceHold, "vowel-hold-out");
                }
                appendRemapKey(keys, endKeyTime, sourceEnd, "note-end");
            } else {
                // 休止、闭口或未识别歌词暂时使用闭口源时间。
                // 未识别的歌词会另外给出提示，后续可加入音源别名映射。
                appendRemapKey(keys, endKeyTime, sourceEnd, "closed-note-end");
                if (note.vowel === "unknown") {
                    warnings.push("音符 " + note.section + " 的歌词别名未识别，已临时按闭口处理：" + note.lyric);
                }
            }

            if (noteDuration < frameDuration) {
                shortNotes++;
            }
        }

        keys.sort(function (a, b) { return a.time - b.time; });
        if (shortNotes > 0) {
            warnings.push(shortNotes + " 个音符短于外层合成的一帧，渲染结果可能无法完整呈现每次口型变化。");
        }
        return {
            keys: keys,
            totalSeconds: totalSeconds,
            requiredOutPoint: requiredOutPoint,
            warnings: warnings,
            unknownCount: parseResult.counts.unknown
        };
    }

    // 检查当前合成与选中图层，再将计算结果写入 Time Remapping。
    function applyTimeRemapToSelectedLayer(parseResult) {
        if (!app.project) {
            throw new Error("当前没有打开的 After Effects 工程。");
        }
        var parentComp = app.project.activeItem;
        if (!(parentComp instanceof CompItem)) {
            throw new Error("请先激活包含目标图层的合成时间轴。");
        }
        if (!parentComp.selectedLayers || parentComp.selectedLayers.length !== 1) {
            throw new Error("请在时间轴中只选中一个需要应用口型的图层。");
        }

        var layer = parentComp.selectedLayers[0];
        if (!(layer instanceof AVLayer)) {
            throw new Error("请选中一个视频素材图层或合成图层。");
        }
        // 视频素材与合成图层均可应用；来源没有样板标记时采用默认时间布局。
        var markerMap = getTemplateMarkerMap(layer.source);
        var plan = buildTimeRemapPlan(parseResult, layer, parentComp, markerMap);

        if (layer.timeRemapEnabled && !confirm(
            "所选图层已启用时间重映射。\n继续将替换该图层现有的时间重映射关键帧。\n\n是否继续？"
        )) {
            return null;
        }
        if (layer.canSetTimeRemapEnabled === false) {
            throw new Error("当前图层不支持时间重映射。请确认选中的是视频素材或预合成图层。");
        }

        app.beginUndoGroup("应用 UST 口型时间重映射");
        try {
            // 重新启用时间重映射，以恢复 AE 自动创建的默认关键帧。
            // 注意：时间重映射属性不能在一个关键帧也没有时添加关键帧，
            // 否则会出现“属性或父级属性被隐藏”的错误。
            if (layer.timeRemapEnabled) {
                layer.timeRemapEnabled = false;
            }
            layer.timeRemapEnabled = true;
            layer.outPoint = plan.requiredOutPoint;

            var remap = layer.property("ADBE Time Remapping");
            if (!remap) {
                throw new Error("无法获取时间重映射属性。");
            }

            var k, j, existingTime, keepKey, keyTimeTolerance = 0.0001;

            // 先写入目标关键帧，保留 AE 创建的默认关键帧，避免属性被隐藏。
            for (k = 0; k < plan.keys.length; k++) {
                remap.setValueAtTime(plan.keys[k].time, plan.keys[k].sourceTime);
            }

            // 目标关键帧全部写入后，再移除不属于本次计划的默认关键帧。
            // 始终至少保留一个关键帧，防止时间重映射属性进入隐藏状态。
            for (k = remap.numKeys; k >= 1; k--) {
                existingTime = remap.keyTime(k);
                keepKey = false;
                for (j = 0; j < plan.keys.length; j++) {
                    if (Math.abs(existingTime - plan.keys[j].time) < keyTimeTolerance) {
                        keepKey = true;
                        break;
                    }
                }
                if (!keepKey && remap.numKeys > 1) {
                    remap.removeKey(k);
                }
            }

            // 音符内部使用线性插值，保证口型从中性形态过渡到维持形态，再返回中性形态。
            // 音符交界处的出点改用保持插值，避免 AE 在相邻源时间之间穿过其他口型段。
            // 例如 i 的出点为 2 秒、下一个 e 的入点为 3 秒；若用线性插值，
            // 两者之间会采样到 u 段，因而在 i→e 的交界错误出现 u 口型。
            var planKey, outgoingInterpolation;
            for (k = 1; k <= remap.numKeys; k++) {
                planKey = null;
                for (j = 0; j < plan.keys.length; j++) {
                    if (Math.abs(remap.keyTime(k) - plan.keys[j].time) < keyTimeTolerance) {
                        planKey = plan.keys[j];
                        break;
                    }
                }

                outgoingInterpolation = KeyframeInterpolationType.LINEAR;
                if (planKey && (planKey.sourceLabel === "note-end" ||
                    planKey.sourceLabel === "closed-note-end")) {
                    outgoingInterpolation = KeyframeInterpolationType.HOLD;
                }

                remap.setInterpolationTypeAtKey(
                    k, KeyframeInterpolationType.LINEAR, outgoingInterpolation
                );
            }
        } finally {
            app.endUndoGroup();
        }
        return plan;
    }

    function tsvCell(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/[\t\r\n]+/g, " ");
    }

    function tsvNumber(value) {
        return Number(value).toFixed(6);
    }

    // 导出可用表格软件查看的音符事件表。
    function writeEventTSV(outputFile, result) {
        var out = new File(outputFile.fsName);
        out.encoding = "UTF-8";
        if (!out.open("w")) {
            throw new Error("无法创建事件表文件：" + outputFile.fsName);
        }
        out.writeln("index\tsection\tstart_tick\tend_tick\tstart_sec\tend_sec\tduration_sec\tbpm\tlyric\tvowel\tevent_type\tnote_number");
        var i, n, row;
        for (i = 0; i < result.notes.length; i++) {
            n = result.notes[i];
            row = [
                n.index,
                n.section,
                tsvNumber(n.startTick),
                tsvNumber(n.endTick),
                tsvNumber(n.startSeconds),
                tsvNumber(n.endSeconds),
                tsvNumber(n.durationSeconds),
                tsvNumber(n.bpm),
                tsvCell(n.lyric),
                n.vowel,
                n.kind,
                tsvCell(n.noteNumber)
            ];
            out.writeln(row.join("\t"));
        }
        out.close();
    }


    // ---- 图形界面 --------------------------------------------------------

    function buildUI(thisObj) {
        // 同时支持停靠面板与独立浮动面板。
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", PANEL_TITLE, undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "fill"];
        win.spacing = 0;
        win.margins = 0;

        // 将样板生成与口型生成分成两个选项卡，避免较长界面被窗口高度遮挡。
        var tabs = win.add("tabbedpanel");
        tabs.alignChildren = ["fill", "fill"];
        tabs.alignment = ["fill", "fill"];
        tabs.margins = 8;

        var templateTab = tabs.add("tab", undefined, "样板合成");
        templateTab.orientation = "column";
        templateTab.alignChildren = ["fill", "top"];
        templateTab.spacing = 8;
        templateTab.margins = 10;

        var ustTab = tabs.add("tab", undefined, "口型生成");
        ustTab.orientation = "column";
        ustTab.alignChildren = ["fill", "top"];
        ustTab.spacing = 8;
        ustTab.margins = 10;

        // 样板合成：使用常见 AE 脚本的分组和对齐方式呈现尺寸参数。
        var sizePanel = templateTab.add("panel", undefined, "合成设置");
        sizePanel.orientation = "column";
        sizePanel.alignChildren = ["fill", "top"];
        sizePanel.spacing = 7;
        sizePanel.margins = 10;

        var presetRow = sizePanel.add("group");
        presetRow.orientation = "row";
        presetRow.alignChildren = ["center", "center"];
        presetRow.spacing = 8;
        presetRow.add("statictext", undefined, "预设");
        var presetChoice = presetRow.add("dropdownlist", undefined, [
            "自定义", "HD 1080（1920 × 1080）", "HD 720（1280 × 720）",
            "竖屏（1080 × 1920）", "方形（1080 × 1080）"
        ]);
        presetChoice.selection = 1;
        presetChoice.alignment = ["fill", "center"];
        presetChoice.helpTip = "选择常用尺寸，选择“自定义”可手动输入宽度和高度。";

        var widthRow = sizePanel.add("group");
        widthRow.orientation = "row";
        widthRow.alignChildren = ["center", "center"];
        widthRow.spacing = 8;
        var widthLabel = widthRow.add("statictext", undefined, "宽度");
        widthLabel.preferredSize.width = 55;
        var widthInput = widthRow.add("edittext", undefined, "1920");
        widthInput.characters = 9;
        widthInput.alignment = ["left", "center"];
        widthRow.add("statictext", undefined, "像素");
        widthInput.helpTip = "合成宽度，范围为 4–30000 之间的整数。";

        var heightRow = sizePanel.add("group");
        heightRow.orientation = "row";
        heightRow.alignChildren = ["center", "center"];
        heightRow.spacing = 8;
        var heightLabel = heightRow.add("statictext", undefined, "高度");
        heightLabel.preferredSize.width = 55;
        var heightInput = heightRow.add("edittext", undefined, "1080");
        heightInput.characters = 9;
        heightInput.alignment = ["left", "center"];
        heightRow.add("statictext", undefined, "像素");
        heightInput.helpTip = "合成高度，范围为 4–30000 之间的整数。";

        presetChoice.onChange = function () {
            var values = [
                null,
                [1920, 1080],
                [1280, 720],
                [1080, 1920],
                [1080, 1080]
            ];
            var index = presetChoice.selection ? presetChoice.selection.index : 0;
            if (index > 0 && values[index]) {
                widthInput.text = String(values[index][0]);
                heightInput.text = String(values[index][1]);
            }
        };
        widthInput.onChanging = function () {
            if (presetChoice.selection && presetChoice.selection.index !== 0) {
                presetChoice.selection = 0;
            }
        };
        heightInput.onChanging = function () {
            if (presetChoice.selection && presetChoice.selection.index !== 0) {
                presetChoice.selection = 0;
            }
        };

        var fixedInfo = sizePanel.add("statictext", undefined,
            "时长：7 秒     帧率：30 fps     元音动画段：各 1 秒");
        fixedInfo.helpTip = "固定参数保证后续 UST 时间重映射使用一致的标记位置。";
        sizePanel.add("statictext", undefined, "o 动画结束后 0.5 秒进入闭口状态。");

        var createButton = templateTab.add("button", undefined, "创建样板合成");
        createButton.alignment = ["fill", "top"];
        createButton.preferredSize.height = 28;

        templateTab.add("statictext", undefined,
            "生成后可在合成中填入口型动画，再切换到“口型生成”。");

        // UST 操作界面与样板设置分开显示，生成样板后自动切换至此选项卡。
        var filePanel = ustTab.add("panel", undefined, "UST 文件");
        filePanel.orientation = "column";
        filePanel.alignChildren = ["fill", "top"];
        filePanel.spacing = 7;
        filePanel.margins = 10;

        var selectedUstFile = null;
        var fileRow = filePanel.add("group");
        fileRow.orientation = "row";
        fileRow.alignChildren = ["center", "center"];
        fileRow.spacing = 8;
        var selectedFileLabel = fileRow.add("statictext", undefined, "尚未选择 UST 文件");
        selectedFileLabel.alignment = ["fill", "center"];
        selectedFileLabel.characters = 28;
        selectedFileLabel.helpTip = "当前选择的 UST 文件名；将鼠标停留在此处可查看完整路径。";
        var chooseFileButton = fileRow.add("button", undefined, "选择…");
        chooseFileButton.preferredSize.width = 70;

        function chooseUSTFile() {
            var picked = File.openDialog("选择传统 UST 文件", "UST 文件:*.ust");
            if (picked) {
                selectedUstFile = picked;
                selectedFileLabel.text = picked.name;
                selectedFileLabel.helpTip = picked.fsName;
                return true;
            }
            return false;
        }

        chooseFileButton.onClick = function () {
            chooseUSTFile();
        };

        var encodingRow = filePanel.add("group");
        encodingRow.orientation = "row";
        encodingRow.alignChildren = ["center", "center"];
        encodingRow.spacing = 8;
        var encodingLabel = encodingRow.add("statictext", undefined, "编码");
        encodingLabel.preferredSize.width = 55;
        var encodingChoice = encodingRow.add("dropdownlist", undefined, [
            "自动（按 Charset；默认 Shift-JIS）", "UTF-8", "Shift-JIS"
        ]);
        encodingChoice.selection = 0;
        encodingChoice.alignment = ["fill", "center"];
        encodingChoice.helpTip = "传统 UST 通常使用 Shift-JIS；文件声明 UTF-8 时会优先按 UTF-8 读取。";

        var parseButton = ustTab.add("button", undefined, "导出.tsv文件");
        parseButton.alignment = ["fill", "top"];
        parseButton.preferredSize.height = 28;
        parseButton.onClick = function () {
            if (!selectedUstFile && !chooseUSTFile()) {
                return;
            }
            try {
                var result = parseUSTFile(selectedUstFile,
                    encodingChoice.selection ? encodingChoice.selection.index : 0);
                var outputFile = File.saveDialog("保存 UST 元音事件表", "TSV:*.tsv");
                if (!outputFile) {
                    return;
                }
                if (!/\.tsv$/i.test(outputFile.name)) {
                    outputFile = new File(outputFile.fsName + ".tsv");
                }
                writeEventTSV(outputFile, result);
            } catch (err) {
                alert("解析 UST 时发生错误：\n" + err.toString(), SCRIPT_NAME);
            }
        };

        var applyButton = ustTab.add("button", undefined, "应用到视频/合成");
        applyButton.alignment = ["fill", "top"];
        applyButton.preferredSize.height = 28;
        applyButton.onClick = function () {
            if (!selectedUstFile && !chooseUSTFile()) {
                return;
            }
            try {
                var result = parseUSTFile(selectedUstFile,
                    encodingChoice.selection ? encodingChoice.selection.index : 0);
                if (result.counts.unknown > 0) {
                    if (!confirm(
                        "检测到 " + result.counts.unknown + " 个未识别的歌词事件。\n" +
                        "本版会暂时将它们按闭口处理；之后可加入音源别名映射。\n\n是否继续应用？"
                    )) {
                        return;
                    }
                }
                var plan = applyTimeRemapToSelectedLayer(result);
                if (!plan) {
                    return;
                }
            } catch (err) {
                alert("应用口型时发生错误：\n" + err.toString(), SCRIPT_NAME);
            }
        };

        createButton.onClick = function () {
            var width = Number(widthInput.text);
            var height = Number(heightInput.text);
            if (!isValidDimension(width)) {
                alert("宽度无效。请输入 4–30000 之间的整数。", SCRIPT_NAME);
                widthInput.active = true;
                return;
            }
            if (!isValidDimension(height)) {
                alert("高度无效。请输入 4–30000 之间的整数。", SCRIPT_NAME);
                heightInput.active = true;
                return;
            }
            if (!app.project) {
                app.newProject();
            }
            app.beginUndoGroup("创建口型样板合成");
            try {
                createTemplate(width, height);
                // 显示后续操作界面，避免用户误以为脚本只负责生成样板。
                tabs.selection = ustTab;
                win.layout.layout(true);
                win.layout.resize();
            } catch (err) {
                alert("创建样板合成时发生错误：\n" + err.toString(), SCRIPT_NAME);
            } finally {
                app.endUndoGroup();
            }
        };

        tabs.selection = templateTab;
        win.onResizing = win.onResize = function () {
            this.layout.resize();
        };
        win.layout.layout(true);
        if (win instanceof Window) {
            win.minimumSize = [380, 360];
            win.preferredSize = [430, 440];
            win.center();
            win.show();
        }
        return win;
    }

    var ui = buildUI(thisObj);
})(this);
