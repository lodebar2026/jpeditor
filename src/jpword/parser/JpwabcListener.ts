// @ts-nocheck -- ANTLR generated
// Generated from src/jpword/Jpwabc.g4 by ANTLR 4.13.2

import {ParseTreeListener} from "antlr4";


import { VoiceContext } from "./JpwabcParser.js";
import { EntryContext } from "./JpwabcParser.js";
import { NoteContext } from "./JpwabcParser.js";
import { BarlineContext } from "./JpwabcParser.js";
import { LinebreakContext } from "./JpwabcParser.js";
import { TextContext } from "./JpwabcParser.js";
import { TimesigContext } from "./JpwabcParser.js";
import { Prelude_begContext } from "./JpwabcParser.js";
import { Prelude_endContext } from "./JpwabcParser.js";


/**
 * This interface defines a complete listener for a parse tree produced by
 * `JpwabcParser`.
 */
export default class JpwabcListener extends ParseTreeListener {
	/**
	 * Enter a parse tree produced by `JpwabcParser.voice`.
	 * @param ctx the parse tree
	 */
	enterVoice?: (ctx: VoiceContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.voice`.
	 * @param ctx the parse tree
	 */
	exitVoice?: (ctx: VoiceContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.entry`.
	 * @param ctx the parse tree
	 */
	enterEntry?: (ctx: EntryContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.entry`.
	 * @param ctx the parse tree
	 */
	exitEntry?: (ctx: EntryContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.note`.
	 * @param ctx the parse tree
	 */
	enterNote?: (ctx: NoteContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.note`.
	 * @param ctx the parse tree
	 */
	exitNote?: (ctx: NoteContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.barline`.
	 * @param ctx the parse tree
	 */
	enterBarline?: (ctx: BarlineContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.barline`.
	 * @param ctx the parse tree
	 */
	exitBarline?: (ctx: BarlineContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.linebreak`.
	 * @param ctx the parse tree
	 */
	enterLinebreak?: (ctx: LinebreakContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.linebreak`.
	 * @param ctx the parse tree
	 */
	exitLinebreak?: (ctx: LinebreakContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.text`.
	 * @param ctx the parse tree
	 */
	enterText?: (ctx: TextContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.text`.
	 * @param ctx the parse tree
	 */
	exitText?: (ctx: TextContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.timesig`.
	 * @param ctx the parse tree
	 */
	enterTimesig?: (ctx: TimesigContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.timesig`.
	 * @param ctx the parse tree
	 */
	exitTimesig?: (ctx: TimesigContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.prelude_beg`.
	 * @param ctx the parse tree
	 */
	enterPrelude_beg?: (ctx: Prelude_begContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.prelude_beg`.
	 * @param ctx the parse tree
	 */
	exitPrelude_beg?: (ctx: Prelude_begContext) => void;
	/**
	 * Enter a parse tree produced by `JpwabcParser.prelude_end`.
	 * @param ctx the parse tree
	 */
	enterPrelude_end?: (ctx: Prelude_endContext) => void;
	/**
	 * Exit a parse tree produced by `JpwabcParser.prelude_end`.
	 * @param ctx the parse tree
	 */
	exitPrelude_end?: (ctx: Prelude_endContext) => void;
}

