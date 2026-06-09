// @ts-nocheck -- ANTLR generated
// Generated from src/jpword/Jpwabc.g4 by ANTLR 4.13.2

import {ParseTreeVisitor} from 'antlr4';


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
 * This interface defines a complete generic visitor for a parse tree produced
 * by `JpwabcParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export default class JpwabcVisitor<Result> extends ParseTreeVisitor<Result> {
	/**
	 * Visit a parse tree produced by `JpwabcParser.voice`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitVoice?: (ctx: VoiceContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.entry`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitEntry?: (ctx: EntryContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.note`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitNote?: (ctx: NoteContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.barline`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitBarline?: (ctx: BarlineContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.linebreak`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLinebreak?: (ctx: LinebreakContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.text`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitText?: (ctx: TextContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.timesig`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTimesig?: (ctx: TimesigContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.prelude_beg`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPrelude_beg?: (ctx: Prelude_begContext) => Result;
	/**
	 * Visit a parse tree produced by `JpwabcParser.prelude_end`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPrelude_end?: (ctx: Prelude_endContext) => Result;
}

