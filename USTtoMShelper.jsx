#target aftereffects
#targetengine "USTtoMShelper"

/*
 * USTtoMShelper - 口型样板、UST 解析与时间重映射
 * v0.8.0
 * 创建 7 秒口型样板，解析 UST/USTX，并根据所选轨道的日语元音生成时间重映射。
 */

(function (thisObj) {
    var SCRIPT_NAME = "USTtoMShelper";
    var PANEL_TITLE = "USTtoMShelper - 口型辅助";

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

        addCompMarker(comp, tA, "a");
        addCompMarker(comp, tI, "i");
        addCompMarker(comp, tU, "u");
        addCompMarker(comp, tE, "e");
        addCompMarker(comp, tO, "o");
        addCompMarker(comp, tOEnd, "o-end");
        addCompMarker(comp, tClosed, "closed");
        addCompMarker(comp, (tA + tI) / 2, "a-hold");
        addCompMarker(comp, (tI + tU) / 2, "i-hold");
        addCompMarker(comp, (tU + tE) / 2, "u-hold");
        addCompMarker(comp, (tE + tO) / 2, "e-hold");
        addCompMarker(comp, (tO + tOEnd) / 2, "o-hold");

        comp.openInViewer();
        return comp;
    }

    // UST 文件读取 
    // 读取编码
    function detectUSTEncoding(rawText, encodingMode) {
        if (encodingMode === 1) {
            return "UTF-8";
        }
        if (encodingMode === 2) {
            return "Shift_JIS";
        }

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

        return "Shift_JIS";
    }

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

    // 日语元音识别

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

    // 将歌词归类为 a/i/u/e/o、closed 或 unknown。
    function classifyLyric(lyric, previousVowel) {
        var original = trimText(lyric);
        var lower = original.toLowerCase();
        var tokens, lastToken, i, ch, hira, found = "", vowel;

        if (original === "" || /^(r|rest|sil|silence|pau|sp|cl|br)$/i.test(original)) {
            return { vowel: "closed", kind: "rest", recognized: true };
        }
        if (/^(っ|ッ)$/.test(original)) {
            // 促音沿用上一个有效元音
            if (previousVowel && /^[aiueo]$/.test(previousVowel)) {
                return { vowel: previousVowel, kind: "sokuon", recognized: true };
            }
            return { vowel: "closed", kind: "sokuon", recognized: true };
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

        // 拗音取最后一个假名
        for (i = 0; i < original.length; i++) {
            ch = original.charAt(i);
            hira = toHiraganaChar(ch);
            if (hira === "ん") {
                found = "closed";
            } else if (hira === "っ") {
                // 促音继承上一个音符的元音
                if (!/^[aiueo]$/.test(found)) {
                    found = (previousVowel && /^[aiueo]$/.test(previousVowel))
                        ? previousVowel : "closed";
                }
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

        // 无法识别假名时，尝试按常见罗马字别名的末尾元音判断，否则保留为 unknown
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

    // 时间计算
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

    // USTX 文件读取
    function readUSTXFile(file) {
        var textFile = new File(file.fsName);
        textFile.encoding = "UTF-8";
        if (!textFile.open("r")) {
            throw new Error("无法读取 USTX 文件：" + file.fsName);
        }
        var text = textFile.read();
        textFile.close();
        return text.replace(/^\uFEFF/, "");
    }

    function yamlIndent(line) {
        var m = line.match(/^[ \t]*/);
        return m ? m[0].length : 0;
    }

    function yamlPair(line) {
        var text = trimText(line);
        if (text.charAt(0) === "-") {
            text = trimText(text.substring(1));
        }
        var p = text.indexOf(":");
        if (p <= 0) {
            return null;
        }
        return {
            key: trimText(text.substring(0, p)).toLowerCase(),
            value: trimText(text.substring(p + 1))
        };
    }

    // 去掉简单标量的引号与行尾注释
    function yamlScalar(value) {
        var v = trimText(value);
        if (!v) {
            return "";
        }
        if (v.charAt(0) === '"' && v.lastIndexOf('"') > 0) {
            v = v.substring(1, v.lastIndexOf('"'));
            v = v.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            return v;
        }
        if (v.charAt(0) === "'" && v.lastIndexOf("'") > 0) {
            return v.substring(1, v.lastIndexOf("'")).replace(/''/g, "'");
        }
        return v.replace(/\s+#.*$/, "");
    }

    // 读取常见的 YAML 行内映射
    function yamlInlineField(value, fieldName) {
        var escaped = fieldName.replace(/[-]/g, "\\-");
        var re = new RegExp("(?:^|[,\\{])\\s*" + escaped + "\\s*:\\s*(\\\"(?:\\\\.|[^\\\"])*\\\"|'(?:''|[^'])*'|[^,}]+)", "i");
        var m = String(value).match(re);
        return m ? yamlScalar(m[1]) : "";
    }

    function parseUSTXStructure(text) {
        var lines = text.split(/\r\n|\n|\r/);
        var section = "";
        var tracks = [];
        var parts = [];
        var tempos = [];
        var projectName = "";
        var defaultBpm = DEFAULT_BPM;
        var resolution = TICKS_PER_QUARTER;
        var i, line, indent, content, pair, dash, payload, k, n;
        var currentTrack = null;
        var trackListIndent = null;
        var singerIndent = -1;
        var currentPart = null;
        var partListIndent = null;
        var inNotes = false;
        var notesPropertyIndent = -1;
        var noteListIndent = null;
        var currentNote = null;
        var currentTempo = null;
        var tempoListIndent = null;

        function applyTrackField(track, key, value, fieldIndent) {
            var raw = trimText(value);
            if (singerIndent >= 0 && fieldIndent > singerIndent) {
                if (key === "id" || key === "name" || key === "path" || key === "location") {
                    if (key === "name") {
                        track.singerName = yamlScalar(raw);
                    } else if (key === "id" && !track.singerId) {
                        track.singerId = yamlScalar(raw);
                    } else if (!track.singerId) {
                        track.singerId = yamlScalar(raw);
                    }
                }
                return;
            }
            if (singerIndent >= 0 && fieldIndent <= singerIndent) {
                singerIndent = -1;
            }
            if (key === "track_name") {
                track.trackName = yamlScalar(raw);
            } else if (key === "name" && !track.trackName) {
                track.trackName = yamlScalar(raw);
            } else if (key === "singer") {
                if (!raw) {
                    singerIndent = fieldIndent;
                } else if (raw.charAt(0) === "{") {
                    track.singerName = yamlInlineField(raw, "name");
                    track.singerId = yamlInlineField(raw, "id");
                    if (!track.singerName) {
                        track.singerName = yamlInlineField(raw, "display_name");
                    }
                } else {
                    track.singerId = yamlScalar(raw);
                }
            }
        }

        function applyPartField(part, key, value) {
            var raw = yamlScalar(value);
            if (key === "name") {
                part.name = raw;
            } else if (key === "track_no") {
                part.trackNo = parseInt(raw, 10);
            } else if (key === "position") {
                part.position = parseFloat(raw);
                if (isNaN(part.position)) {
                    part.position = 0;
                }
            }
        }

        function applyNoteField(note, key, value) {
            var raw = yamlScalar(value);
            if (key === "position") {
                note.position = parseFloat(raw);
            } else if (key === "duration") {
                note.duration = parseFloat(raw);
            } else if (key === "lyric") {
                note.lyric = raw;
            } else if (key === "tone") {
                note.tone = parseInt(raw, 10);
            }
        }

        for (i = 0; i < lines.length; i++) {
            line = lines[i];
            content = trimText(line);
            if (!content || content.charAt(0) === "#") {
                continue;
            }
            indent = yamlIndent(line);

            // 顶层字段均从第 0 列开始；切换顶层区域时重置当前解析对象。
            if (indent === 0 && content.charAt(0) !== "-") {
                pair = yamlPair(content);
                if (pair) {
                    section = pair.key;
                    currentTrack = null;
                    currentPart = null;
                    currentTempo = null;
                    inNotes = false;
                    notesPropertyIndent = -1;
                    noteListIndent = null;
                    singerIndent = -1;
                    if (section === "name") {
                        projectName = yamlScalar(pair.value);
                    } else if (section === "bpm") {
                        n = parseFloat(yamlScalar(pair.value));
                        if (!isNaN(n) && n > 0) {
                            defaultBpm = n;
                        }
                    } else if (section === "resolution") {
                        n = parseFloat(yamlScalar(pair.value));
                        if (!isNaN(n) && n > 0) {
                            resolution = n;
                        }
                    }
                    continue;
                }
            }

            dash = line.match(/^([ \t]*)-\s*(.*)$/);
            payload = dash ? dash[2] : "";

            if (section === "tracks") {
                if (dash && (trackListIndent === null || indent === trackListIndent)) {
                    if (trackListIndent === null) {
                        trackListIndent = indent;
                    }
                    currentTrack = {
                        index: tracks.length,
                        trackNo: tracks.length,
                        trackName: "",
                        singerId: "",
                        singerName: "",
                        singer: ""
                    };
                    tracks.push(currentTrack);
                    singerIndent = -1;
                    if (payload) {
                        pair = yamlPair(payload);
                        if (pair) {
                            applyTrackField(currentTrack, pair.key, pair.value, indent + 2);
                        } else if (payload.charAt(0) === "{") {
                            currentTrack.trackName = yamlInlineField(payload, "track_name");
                            currentTrack.singerName = yamlInlineField(payload, "singer_name");
                            currentTrack.singerId = yamlInlineField(payload, "singer");
                        }
                    }
                    continue;
                }
                pair = yamlPair(content);
                if (currentTrack && pair && indent > trackListIndent) {
                    applyTrackField(currentTrack, pair.key, pair.value, indent);
                }
            } else if (section === "voice_parts") {
                // 声部列表项与其内部 notes 列表的缩进不同。
                if (dash && (partListIndent === null || indent === partListIndent)) {
                    if (partListIndent === null) {
                        partListIndent = indent;
                    }
                    currentPart = {
                        name: "",
                        trackNo: -1,
                        position: 0,
                        notes: []
                    };
                    parts.push(currentPart);
                    inNotes = false;
                    notesPropertyIndent = -1;
                    noteListIndent = null;
                    currentNote = null;
                    if (payload) {
                        pair = yamlPair(payload);
                        if (pair) {
                            applyPartField(currentPart, pair.key, pair.value);
                        } else if (payload.charAt(0) === "{") {
                            currentPart.name = yamlInlineField(payload, "name");
                            currentPart.trackNo = parseInt(yamlInlineField(payload, "track_no"), 10);
                            currentPart.position = parseFloat(yamlInlineField(payload, "position")) || 0;
                        }
                    }
                    continue;
                }

                pair = yamlPair(content);
                if (inNotes) {
                    if (dash) {
                        if (noteListIndent === null && indent > partListIndent) {
                            noteListIndent = indent;
                        }
                        if (noteListIndent !== null && indent === noteListIndent) {
                            currentNote = { position: NaN, duration: NaN, lyric: "", tone: "" };
                            currentPart.notes.push(currentNote);
                            if (payload) {
                                pair = yamlPair(payload);
                                if (pair) {
                                    applyNoteField(currentNote, pair.key, pair.value);
                                } else if (payload.charAt(0) === "{") {
                                    currentNote.position = parseFloat(yamlInlineField(payload, "position"));
                                    currentNote.duration = parseFloat(yamlInlineField(payload, "duration"));
                                    currentNote.lyric = yamlInlineField(payload, "lyric");
                                    currentNote.tone = yamlInlineField(payload, "tone");
                                }
                            }
                            continue;
                        }
                    }
                    if (pair && noteListIndent !== null && indent > noteListIndent) {
                        applyNoteField(currentNote, pair.key, pair.value);
                        continue;
                    }
                    if (pair && ((noteListIndent !== null && indent <= noteListIndent) ||
                        (noteListIndent === null && indent <= notesPropertyIndent))) {
                        inNotes = false;
                        currentNote = null;
                    } else {
                        continue;
                    }
                }

                pair = yamlPair(content);
                if (currentPart && pair && indent > partListIndent) {
                    if (pair.key === "notes") {
                        notesPropertyIndent = indent;
                        noteListIndent = null;
                        currentNote = null;
                        inNotes = pair.value === "";
                    } else {
                        applyPartField(currentPart, pair.key, pair.value);
                    }
                }
            } else if (section === "tempos") {
                if (dash && (tempoListIndent === null || indent === tempoListIndent)) {
                    if (tempoListIndent === null) {
                        tempoListIndent = indent;
                    }
                    currentTempo = { position: 0, bpm: NaN };
                    tempos.push(currentTempo);
                    if (payload) {
                        pair = yamlPair(payload);
                        if (pair) {
                            if (pair.key === "position") {
                                currentTempo.position = parseFloat(yamlScalar(pair.value));
                            } else if (pair.key === "bpm") {
                                currentTempo.bpm = parseFloat(yamlScalar(pair.value));
                            }
                        } else if (payload.charAt(0) === "{") {
                            currentTempo.position = parseFloat(yamlInlineField(payload, "position"));
                            currentTempo.bpm = parseFloat(yamlInlineField(payload, "bpm"));
                        }
                    }
                    continue;
                }
                pair = yamlPair(content);
                if (currentTempo && pair && indent > tempoListIndent) {
                    if (pair.key === "position") {
                        currentTempo.position = parseFloat(yamlScalar(pair.value));
                    } else if (pair.key === "bpm") {
                        currentTempo.bpm = parseFloat(yamlScalar(pair.value));
                    }
                }
            }
        }

        if (tracks.length === 0) {
            throw new Error("没有在 USTX 文件中找到 tracks 轨道列表。");
        }
        if (parts.length === 0) {
            throw new Error("没有在 USTX 文件中找到 voice_parts 音符数据。");
        }
        if (tempos.length === 0) {
            tempos.push({ position: 0, bpm: defaultBpm });
        }
        return {
            name: projectName,
            tracks: tracks,
            parts: parts,
            tempos: tempos,
            defaultBpm: defaultBpm,
            resolution: resolution
        };
    }

    // 将 USTX 的 Tempo 列表整理成绝对 tick 与对应秒数
    function buildUSTXTempoTimeline(tempoEvents, defaultBpm) {
        var events = [];
        var i, event, position, bpm;
        var hasTempoAtZero = false;
        for (i = 0; i < tempoEvents.length; i++) {
            event = tempoEvents[i];
            position = Number(event.position);
            bpm = Number(event.bpm);
            if (isNaN(position) || isNaN(bpm) || bpm <= 0 || position < 0) {
                continue;
            }
            if (Math.abs(position) < 0.000001) {
                hasTempoAtZero = true;
            }
            events.push({ position: position, bpm: bpm, order: i });
        }
        if (!hasTempoAtZero) {
            events.push({ position: 0, bpm: defaultBpm, order: -1 });
        }
        events.sort(function (a, b) {
            if (a.position !== b.position) {
                return a.position - b.position;
            }
            return a.order - b.order;
        });

        var collapsed = [];
        for (i = 0; i < events.length; i++) {
            event = events[i];
            if (collapsed.length > 0 && Math.abs(collapsed[collapsed.length - 1].position - event.position) < 0.000001) {
                collapsed[collapsed.length - 1].bpm = event.bpm;
            } else {
                collapsed.push({ position: event.position, bpm: event.bpm });
            }
        }
        if (collapsed.length === 0 || collapsed[0].position > 0) {
            collapsed.unshift({ position: 0, bpm: defaultBpm });
        }

        var timeline = [];
        var seconds = 0;
        for (i = 0; i < collapsed.length; i++) {
            if (i > 0) {
                seconds += (collapsed[i].position - collapsed[i - 1].position) *
                    (60.0 / (TICKS_PER_QUARTER * collapsed[i - 1].bpm));
            }
            timeline.push({
                position: collapsed[i].position,
                seconds: seconds,
                bpm: collapsed[i].bpm
            });
        }
        return timeline;
    }

    function ustxTickToSeconds(tick, timeline) {
        var i, segment = timeline[0];
        for (i = 1; i < timeline.length; i++) {
            if (timeline[i].position <= tick) {
                segment = timeline[i];
            } else {
                break;
            }
        }
        return segment.seconds + (tick - segment.position) *
            (60.0 / (TICKS_PER_QUARTER * segment.bpm));
    }

    function ustxBpmAtTick(tick, timeline) {
        var i, bpm = timeline.length ? timeline[0].bpm : DEFAULT_BPM;
        for (i = 0; i < timeline.length; i++) {
            if (timeline[i].position <= tick) {
                bpm = timeline[i].bpm;
            } else {
                break;
            }
        }
        return bpm;
    }

    function summarizeEventCounts(result) {
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

    // 将 USTX 中指定 track_no 的所有声部整理到同一条时间线上
    function buildUSTXTrackResult(project, track, tempoTimeline, trackWarnings) {
        var rawNotes = [];
        var partIndex, noteIndex, part, raw, note, i;
        var partNotes, startTick, endTick;
        var notes = [];
        var warnings = trackWarnings;

        for (partIndex = 0; partIndex < project.parts.length; partIndex++) {
            part = project.parts[partIndex];
            if (part.trackNo !== track.trackNo) {
                continue;
            }
            for (noteIndex = 0; noteIndex < part.notes.length; noteIndex++) {
                partNotes = part.notes[noteIndex];
                startTick = Number(part.position) + Number(partNotes.position);
                endTick = startTick + Number(partNotes.duration);
                if (isNaN(startTick) || isNaN(endTick) || endTick <= startTick) {
                    warnings.push("轨道“" + track.trackName + "”中存在无效音符时长，已跳过。");
                    continue;
                }
                rawNotes.push({
                    startTick: startTick,
                    endTick: endTick,
                    lyric: partNotes.lyric === undefined ? "" : String(partNotes.lyric),
                    tone: partNotes.tone === undefined ? "" : partNotes.tone,
                    section: (part.name || ("声部" + (partIndex + 1))) + "#" + (noteIndex + 1),
                    partIndex: partIndex,
                    noteIndex: noteIndex
                });
            }
        }

        rawNotes.sort(function (a, b) {
            if (a.startTick !== b.startTick) {
                return a.startTick - b.startTick;
            }
            if (a.partIndex !== b.partIndex) {
                return a.partIndex - b.partIndex;
            }
            return a.noteIndex - b.noteIndex;
        });

        // 处理同一轨道重叠情况
        var nonOverlapping = [];
        var last;
        for (i = 0; i < rawNotes.length; i++) {
            raw = rawNotes[i];
            while (nonOverlapping.length > 0) {
                last = nonOverlapping[nonOverlapping.length - 1];
                if (raw.startTick >= last.endTick) {
                    break;
                }
                warnings.push("轨道“" + track.trackName + "”存在重叠音符，已按后开始的音符截短前一音符。");
                if (raw.startTick <= last.startTick) {
                    nonOverlapping.pop();
                } else {
                    last.endTick = raw.startTick;
                    break;
                }
            }
            if (raw.endTick > raw.startTick) {
                nonOverlapping.push(raw);
            }
        }

        var cursorTick = 0;
        var previousVowel = "";
        var item, classified, gapEvent, totalTicks = 0;
        for (i = 0; i < nonOverlapping.length; i++) {
            raw = nonOverlapping[i];
            if (raw.startTick > cursorTick) {
                gapEvent = {
                    index: notes.length + 1,
                    section: "gap_" + cursorTick + "_" + raw.startTick,
                    startTick: cursorTick,
                    endTick: raw.startTick,
                    startSeconds: ustxTickToSeconds(cursorTick, tempoTimeline),
                    endSeconds: ustxTickToSeconds(raw.startTick, tempoTimeline),
                    durationSeconds: ustxTickToSeconds(raw.startTick, tempoTimeline) - ustxTickToSeconds(cursorTick, tempoTimeline),
                    bpm: ustxBpmAtTick(cursorTick, tempoTimeline),
                    lyric: "",
                    vowel: "closed",
                    kind: "rest",
                    recognized: true,
                    noteNumber: "",
                    trackNo: track.trackNo,
                    trackName: track.trackName,
                    singer: track.singer,
                    isGap: true,
                    startsAfterGap: false
                };
                notes.push(gapEvent);
                previousVowel = "";
            }

            classified = classifyLyric(raw.lyric, previousVowel);
            var previousEvent = notes.length > 0 ? notes[notes.length - 1] : null;
            var followsClosed = !previousEvent || previousEvent.isGap || previousEvent.vowel === "closed" || previousEvent.vowel === "unknown";
            item = {
                index: notes.length + 1,
                section: raw.section,
                startTick: raw.startTick,
                endTick: raw.endTick,
                startSeconds: ustxTickToSeconds(raw.startTick, tempoTimeline),
                endSeconds: ustxTickToSeconds(raw.endTick, tempoTimeline),
                durationSeconds: ustxTickToSeconds(raw.endTick, tempoTimeline) - ustxTickToSeconds(raw.startTick, tempoTimeline),
                bpm: ustxBpmAtTick(raw.startTick, tempoTimeline),
                lyric: raw.lyric,
                vowel: classified.vowel,
                kind: classified.kind,
                recognized: classified.recognized,
                noteNumber: raw.tone,
                trackNo: track.trackNo,
                trackName: track.trackName,
                singer: track.singer,
                isGap: false,
                startsAfterGap: followsClosed
            };
            notes.push(item);
            if (/^[aiueo]$/.test(classified.vowel)) {
                previousVowel = classified.vowel;
            } else {
                previousVowel = "";
            }
            cursorTick = raw.endTick;
            if (raw.endTick > totalTicks) {
                totalTicks = raw.endTick;
            }
        }

        var result = {
            format: "ustx",
            fileName: "",
            trackNo: track.trackNo,
            trackName: track.trackName,
            singer: track.singer,
            notes: notes,
            warnings: warnings,
            initialBpm: tempoTimeline.length ? tempoTimeline[0].bpm : DEFAULT_BPM,
            totalTicks: totalTicks,
            totalSeconds: ustxTickToSeconds(totalTicks, tempoTimeline),
            noteSectionsFound: nonOverlapping.length
        };
        summarizeEventCounts(result);
        return result;
    }

    // 解析整个 USTX 项目
    function parseUSTXFile(file) {
        var structure = parseUSTXStructure(readUSTXFile(file));
        var tempoTimeline = buildUSTXTempoTimeline(structure.tempos, structure.defaultBpm);
        var i, track, trackResult, allNotes = [], allWarnings = [];
        var trackResults = [];
        var trackOptions = [];
        var maxSeconds = 0;

        for (i = 0; i < structure.tracks.length; i++) {
            track = structure.tracks[i];
            track.trackNo = i;
            if (!track.trackName) {
                track.trackName = "轨道 " + (i + 1);
            }
            if (track.singerName && track.singerId && track.singerName !== track.singerId) {
                track.singer = track.singerName + "（" + track.singerId + "）";
            } else {
                track.singer = track.singerName || track.singerId || "未指定歌手";
            }
            trackOptions.push({
                trackNo: i,
                trackName: track.trackName,
                singer: track.singer
            });
            trackResult = buildUSTXTrackResult(structure, track, tempoTimeline, []);
            trackResult.fileName = file.name;
            trackResults.push(trackResult);
            for (var j = 0; j < trackResult.notes.length; j++) {
                allNotes.push(trackResult.notes[j]);
            }
            for (j = 0; j < trackResult.warnings.length; j++) {
                allWarnings.push(trackResult.warnings[j]);
            }
            if (trackResult.totalSeconds > maxSeconds) {
                maxSeconds = trackResult.totalSeconds;
            }
        }

        allNotes.sort(function (a, b) {
            if (a.startSeconds !== b.startSeconds) {
                return a.startSeconds - b.startSeconds;
            }
            return a.trackNo - b.trackNo;
        });
        var exportResult = {
            format: "ustx",
            fileName: file.name,
            notes: allNotes,
            warnings: allWarnings,
            totalSeconds: maxSeconds,
            totalTicks: 0,
            initialBpm: tempoTimeline.length ? tempoTimeline[0].bpm : DEFAULT_BPM,
            trackResults: trackResults,
            tracks: trackOptions
        };
        summarizeEventCounts(exportResult);
        return {
            format: "ustx",
            fileName: file.name,
            tracks: trackOptions,
            trackResults: trackResults,
            exportResult: exportResult,
            projectName: structure.name,
            warnings: allWarnings
        };
    }

    // 标记读取与时间重映射 
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

        // 若来源是预合成且含有全部标记，则采用其实际时间
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

    // 合并相邻的同元音音符
    function mergeContinuousSameVowelNotes(notes) {
        var merged = [];
        var i, note, current, key, copy, isContinuous;
        var epsilon = 0.000001;

        for (i = 0; i < notes.length; i++) {
            note = notes[i];
            copy = {};
            for (key in note) {
                if (note.hasOwnProperty(key)) {
                    copy[key] = note[key];
                }
            }

            current = merged.length > 0 ? merged[merged.length - 1] : null;
            isContinuous = current !== null &&
                isVowelEvent(current) && isVowelEvent(copy) &&
                current.vowel === copy.vowel &&
                !current.isGap && !copy.isGap &&
                !copy.startsAfterGap &&
                Math.abs(current.endSeconds - copy.startSeconds) <= epsilon;

            if (isContinuous) {
                if (!current.sameVowelBoundaries) {
                    current.sameVowelBoundaries = [];
                }
                current.sameVowelBoundaries.push(copy.startSeconds);
                current.endSeconds = copy.endSeconds;
                current.endTick = copy.endTick;
                current.durationSeconds = current.endSeconds - current.startSeconds;
                current.mergedNoteCount = (current.mergedNoteCount || 1) + (copy.mergedNoteCount || 1);
            } else {
                merged.push(copy);
            }
        }
        return merged;
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

    // 将 UST 音符转换为外层合成时间与样板源时间之间的关键帧
    function buildTimeRemapPlan(parseResult, layer, parentComp, markerMap) {
        var notes = mergeContinuousSameVowelNotes(parseResult.notes);
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
        var firstSameVowelBoundary, lastSameVowelBoundary, availableIn, availableOut;
        var tiny = 0.000001;
        var shortNotes = 0;

        if (notes.length === 0 || totalSeconds <= 0) {
            throw new Error("UST 中没有可用于生成口型的有效音符。");
        }

        if (requiredOutPoint > parentComp.duration + tiny) {
            warnings.push(
                "当前合成时长不足以容纳这份 UST。\n" +
                "需要结束于 " + requiredOutPoint.toFixed(3) +
                " 秒，当前合成结束于 " +
                parentComp.duration.toFixed(3) + " 秒。\n" +
                "\n超出合成范围的口型不会被生成。"
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

            sourceStart = sourceBase + ((i === 0 || !isVowelEvent(note) || note.startsAfterGap) ? 0.25 : 0.0);

            trimsOutgoing = nextNote !== null && !isVowelEvent(nextNote);
            if (isVowelEvent(note)) {
                sourceHold = markerMap.hold[vowel];
                sourceEnd = trimsOutgoing ? sourceBase + 0.75 : markerMap.end[vowel];
            } else {
                sourceHold = null;
                sourceEnd = trimsOutgoing ? sourceBase + 0.75 : sourceStart;
            }

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
                if (note.sameVowelBoundaries && note.sameVowelBoundaries.length > 0) {
                    firstSameVowelBoundary = baseInPoint + note.sameVowelBoundaries[0];
                    lastSameVowelBoundary = baseInPoint + note.sameVowelBoundaries[note.sameVowelBoundaries.length - 1];
                    availableIn = Math.max(0, (firstSameVowelBoundary - noteStart) / 2.0);
                    availableOut = Math.max(0, (endKeyTime - lastSameVowelBoundary) / 2.0);
                    transitionIn = Math.min(inDistance, availableIn);
                    transitionOut = Math.min(outDistance, availableOut);
                } else {
                    transitionIn = Math.min(inDistance, noteDuration / 2.0);
                    transitionOut = Math.min(outDistance, noteDuration / 2.0);
                }
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

    // 将计算结果写入时间重映射
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

            // 保留 AE 创建的默认关键帧，避免属性被隐藏
            for (k = 0; k < plan.keys.length; k++) {
                remap.setValueAtTime(plan.keys[k].time, plan.keys[k].sourceTime);
            }
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

    function writeEventTSV(outputFile, result) {
        var out = new File(outputFile.fsName);
        out.encoding = "UTF-8";
        if (!out.open("w")) {
            throw new Error("无法创建事件表文件：" + outputFile.fsName);
        }
        if (result.format === "ustx") {
            out.writeln("track_no\ttrack_name\tsinger\tindex\tsection\tstart_tick\tend_tick\tstart_sec\tend_sec\tduration_sec\tbpm\tlyric\tvowel\tevent_type\tnote_number");
        } else {
            out.writeln("index\tsection\tstart_tick\tend_tick\tstart_sec\tend_sec\tduration_sec\tbpm\tlyric\tvowel\tevent_type\tnote_number");
        }
        var i, n, row;
        for (i = 0; i < result.notes.length; i++) {
            n = result.notes[i];
            if (result.format === "ustx") {
                row = [
                    n.trackNo,
                    tsvCell(n.trackName),
                    tsvCell(n.singer),
                    n.index,
                    tsvCell(n.section),
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
            } else {
                row = [
                    n.index,
                    tsvCell(n.section),
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
            }
            out.writeln(row.join("\t"));
        }
        out.close();
    }

    // UI
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", PANEL_TITLE, undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "fill"];
        win.spacing = 0;
        win.margins = 0;

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

        var filePanel = ustTab.add("panel", undefined, "UST 文件");
        filePanel.orientation = "column";
        filePanel.alignChildren = ["fill", "top"];
        filePanel.spacing = 7;
        filePanel.margins = 10;

        var selectedUstFile = null;
        var selectedUstxProject = null;
        var fileRow = filePanel.add("group");
        fileRow.orientation = "row";
        fileRow.alignChildren = ["center", "center"];
        fileRow.spacing = 8;
        var selectedFileLabel = fileRow.add("statictext", undefined, "尚未选择 UST/USTX 文件");
        selectedFileLabel.alignment = ["fill", "center"];
        selectedFileLabel.characters = 28;
        selectedFileLabel.helpTip = "当前选择的文件名；将鼠标停留在此处可查看完整路径。";
        var chooseFileButton = fileRow.add("button", undefined, "选择…");
        chooseFileButton.preferredSize.width = 70;

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
        encodingChoice.helpTip = "传统 UST 通常使用 Shift-JIS；文件声明 UTF-8 时会优先按 UTF-8 读取。USTX 固定按 UTF-8 读取。";

        var trackRow = filePanel.add("group");
        trackRow.orientation = "row";
        trackRow.alignChildren = ["center", "center"];
        trackRow.spacing = 8;
        trackRow.visible = false;
        var trackLabel = trackRow.add("statictext", undefined, "轨道-歌手");
        trackLabel.preferredSize.width = 70;
        var trackChoice = trackRow.add("dropdownlist", undefined, []);
        trackChoice.alignment = ["fill", "center"];
        trackChoice.preferredSize.width = 285;
        trackChoice.helpTip = "显示当前所选的轨道-歌手；应用口型时只处理当前轨道，导出 TSV 时仍会导出所有轨道。";
        trackChoice.onChange = function () {
            if (trackChoice.selection) {
                trackChoice.helpTip = "当前所选项：" + trackChoice.selection.text +
                    "。应用口型时只处理该轨道；导出 TSV 时仍会导出所有轨道。";
            }
        };

        function refreshFilePanel() {
            filePanel.layout.layout(true);
            ustTab.layout.layout(true);
            win.layout.layout(true);
            win.layout.resize();
        }

        function fillUSTXTrackChoice(projectData) {
            var i, item, selectedIndex = 0, foundDefault = false;
            trackChoice.removeAll();
            for (i = 0; i < projectData.tracks.length; i++) {
                item = projectData.tracks[i];
                trackChoice.add("item", item.trackName + " - " + item.singer);
                if (!foundDefault && projectData.trackResults[i].notes.length > 0) {
                    selectedIndex = i;
                    foundDefault = true;
                }
            }
            if (trackChoice.items.length > 0) {
                trackChoice.selection = trackChoice.items[selectedIndex];
                if (trackChoice.selection) {
                    trackChoice.helpTip = "当前所选项：" + trackChoice.selection.text +
                        "。应用口型时只处理该轨道；导出 TSV 时仍会导出所有轨道。";
                }
            }
        }

        function chooseUSTFile() {
            var picked = File.openDialog("选择 UST 或 USTX 文件", "UST/USTX 文件:*.ust;*.ustx");
            if (!picked) {
                return false;
            }
            var isUstx = /\.ustx$/i.test(picked.name);
            if (!isUstx && !/\.ust$/i.test(picked.name)) {
                alert("请选择 .ust 或 .ustx 文件。", SCRIPT_NAME);
                return false;
            }

            var parsedUstx = null;
            if (isUstx) {
                try {
                    parsedUstx = parseUSTXFile(picked);
                } catch (parseError) {
                    alert("解析 USTX 时发生错误：\n" + parseError.toString(), SCRIPT_NAME);
                    return false;
                }
            }

            selectedUstFile = picked;
            selectedUstxProject = parsedUstx;
            selectedFileLabel.text = picked.name;
            selectedFileLabel.helpTip = picked.fsName;
            encodingRow.visible = !isUstx;
            trackRow.visible = isUstx;
            if (isUstx) {
                fillUSTXTrackChoice(selectedUstxProject);
            } else {
                trackChoice.removeAll();
            }
            refreshFilePanel();
            return true;
        }

        chooseFileButton.onClick = function () {
            chooseUSTFile();
        };

        var parseButton = ustTab.add("button", undefined, "导出.tsv文件");
        parseButton.alignment = ["fill", "top"];
        parseButton.preferredSize.height = 28;
        parseButton.onClick = function () {
            if (!selectedUstFile && !chooseUSTFile()) {
                return;
            }
            try {
                var result;
                if (/\.ustx$/i.test(selectedUstFile.name)) {
                    if (!selectedUstxProject) {
                        selectedUstxProject = parseUSTXFile(selectedUstFile);
                    }
                    result = selectedUstxProject.exportResult;
                } else {
                    result = parseUSTFile(selectedUstFile,
                        encodingChoice.selection ? encodingChoice.selection.index : 0);
                }
                var outputFile = File.saveDialog("保存元音事件表", "TSV:*.tsv");
                if (!outputFile) {
                    return;
                }
                if (!/\.tsv$/i.test(outputFile.name)) {
                    outputFile = new File(outputFile.fsName + ".tsv");
                }
                writeEventTSV(outputFile, result);
            } catch (err) {
                alert("解析文件时发生错误：\n" + err.toString(), SCRIPT_NAME);
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
                var result;
                if (/\.ustx$/i.test(selectedUstFile.name)) {
                    if (!selectedUstxProject) {
                        selectedUstxProject = parseUSTXFile(selectedUstFile);
                    }
                    if (!trackChoice.selection) {
                        throw new Error("请先选择要应用的 USTX 轨道。");
                    }
                    result = selectedUstxProject.trackResults[trackChoice.selection.index];
                    if (!result || result.notes.length === 0 || result.totalSeconds <= 0) {
                        throw new Error("选中的轨道没有可用于生成口型的有效音符。");
                    }
                } else {
                    result = parseUSTFile(selectedUstFile,
                        encodingChoice.selection ? encodingChoice.selection.index : 0);
                }
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
