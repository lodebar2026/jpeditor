// @ts-nocheck -- ANTLR generated
// Generated from src/jpword/Jpwabc.g4 by ANTLR 4.13.2
// noinspection ES6UnusedImports,JSUnusedGlobalSymbols,JSUnusedLocalSymbols

import {
	ATN,
	ATNDeserializer, DecisionState, DFA, FailedPredicateException,
	RecognitionException, NoViableAltException, BailErrorStrategy,
	Parser, ParserATNSimulator,
	RuleContext, ParserRuleContext, PredictionMode, PredictionContextCache,
	TerminalNode, RuleNode,
	Token, TokenStream,
	Interval, IntervalSet
} from 'antlr4';
import JpwabcListener from "./JpwabcListener.js";
import JpwabcVisitor from "./JpwabcVisitor.js";

// for running tests with parameters, TODO: discuss strategy for typed parameters in CI
// eslint-disable-next-line no-unused-vars
type int = number;

export default class JpwabcParser extends Parser {
	public static readonly Prelude_beg = 1;
	public static readonly Prelude_end = 2;
	public static readonly Note = 3;
	public static readonly LBRACK = 4;
	public static readonly RBRACK = 5;
	public static readonly Barline = 6;
	public static readonly RBRACE = 7;
	public static readonly Return = 8;
	public static readonly TimeSig = 9;
	public static readonly STRING = 10;
	public static readonly LINE_COMMENT = 11;
	public static readonly WS = 12;
	public static override readonly EOF = Token.EOF;
	public static readonly RULE_voice = 0;
	public static readonly RULE_entry = 1;
	public static readonly RULE_note = 2;
	public static readonly RULE_barline = 3;
	public static readonly RULE_linebreak = 4;
	public static readonly RULE_text = 5;
	public static readonly RULE_timesig = 6;
	public static readonly RULE_prelude_beg = 7;
	public static readonly RULE_prelude_end = 8;
	public static readonly literalNames: (string | null)[] = [ null, null, 
                                                            null, null, 
                                                            "'['", "']'", 
                                                            null, "')'" ];
	public static readonly symbolicNames: (string | null)[] = [ null, "Prelude_beg", 
                                                             "Prelude_end", 
                                                             "Note", "LBRACK", 
                                                             "RBRACK", "Barline", 
                                                             "RBRACE", "Return", 
                                                             "TimeSig", 
                                                             "STRING", "LINE_COMMENT", 
                                                             "WS" ];
	// tslint:disable:no-trailing-whitespace
	public static readonly ruleNames: string[] = [
		"voice", "entry", "note", "barline", "linebreak", "text", "timesig", "prelude_beg", 
		"prelude_end",
	];
	public get grammarFileName(): string { return "Jpwabc.g4"; }
	public get literalNames(): (string | null)[] { return JpwabcParser.literalNames; }
	public get symbolicNames(): (string | null)[] { return JpwabcParser.symbolicNames; }
	public get ruleNames(): string[] { return JpwabcParser.ruleNames; }
	public get serializedATN(): number[] { return JpwabcParser._serializedATN; }

	protected createFailedPredicateException(predicate?: string, message?: string): FailedPredicateException {
		return new FailedPredicateException(this, predicate, message);
	}

	constructor(input: TokenStream) {
		super(input);
		this._interp = new ParserATNSimulator(this, JpwabcParser._ATN, JpwabcParser.DecisionsToDFA, new PredictionContextCache());
	}
	// @RuleVersion(0)
	public voice(): VoiceContext {
		let localctx: VoiceContext = new VoiceContext(this, this._ctx, this.state);
		this.enterRule(localctx, 0, JpwabcParser.RULE_voice);
		let _la: number;
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 21;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while ((((_la) & ~0x1F) === 0 && ((1 << _la) & 1870) !== 0)) {
				{
				{
				this.state = 18;
				this.entry();
				}
				}
				this.state = 23;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public entry(): EntryContext {
		let localctx: EntryContext = new EntryContext(this, this._ctx, this.state);
		this.enterRule(localctx, 2, JpwabcParser.RULE_entry);
		try {
			this.state = 31;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case 3:
				this.enterOuterAlt(localctx, 1);
				{
				this.state = 24;
				this.note();
				}
				break;
			case 6:
				this.enterOuterAlt(localctx, 2);
				{
				this.state = 25;
				this.barline();
				}
				break;
			case 8:
				this.enterOuterAlt(localctx, 3);
				{
				this.state = 26;
				this.linebreak();
				}
				break;
			case 10:
				this.enterOuterAlt(localctx, 4);
				{
				this.state = 27;
				this.text();
				}
				break;
			case 9:
				this.enterOuterAlt(localctx, 5);
				{
				this.state = 28;
				this.timesig();
				}
				break;
			case 1:
				this.enterOuterAlt(localctx, 6);
				{
				this.state = 29;
				this.prelude_beg();
				}
				break;
			case 2:
				this.enterOuterAlt(localctx, 7);
				{
				this.state = 30;
				this.prelude_end();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public note(): NoteContext {
		let localctx: NoteContext = new NoteContext(this, this._ctx, this.state);
		this.enterRule(localctx, 4, JpwabcParser.RULE_note);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 33;
			this.match(JpwabcParser.Note);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public barline(): BarlineContext {
		let localctx: BarlineContext = new BarlineContext(this, this._ctx, this.state);
		this.enterRule(localctx, 6, JpwabcParser.RULE_barline);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 35;
			this.match(JpwabcParser.Barline);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public linebreak(): LinebreakContext {
		let localctx: LinebreakContext = new LinebreakContext(this, this._ctx, this.state);
		this.enterRule(localctx, 8, JpwabcParser.RULE_linebreak);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 37;
			this.match(JpwabcParser.Return);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public text(): TextContext {
		let localctx: TextContext = new TextContext(this, this._ctx, this.state);
		this.enterRule(localctx, 10, JpwabcParser.RULE_text);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 39;
			this.match(JpwabcParser.STRING);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public timesig(): TimesigContext {
		let localctx: TimesigContext = new TimesigContext(this, this._ctx, this.state);
		this.enterRule(localctx, 12, JpwabcParser.RULE_timesig);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 41;
			this.match(JpwabcParser.TimeSig);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public prelude_beg(): Prelude_begContext {
		let localctx: Prelude_begContext = new Prelude_begContext(this, this._ctx, this.state);
		this.enterRule(localctx, 14, JpwabcParser.RULE_prelude_beg);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 43;
			this.match(JpwabcParser.Prelude_beg);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}
	// @RuleVersion(0)
	public prelude_end(): Prelude_endContext {
		let localctx: Prelude_endContext = new Prelude_endContext(this, this._ctx, this.state);
		this.enterRule(localctx, 16, JpwabcParser.RULE_prelude_end);
		try {
			this.enterOuterAlt(localctx, 1);
			{
			this.state = 45;
			this.match(JpwabcParser.Prelude_end);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return localctx;
	}

	public static readonly _serializedATN: number[] = [4,1,12,48,2,0,7,0,2,
	1,7,1,2,2,7,2,2,3,7,3,2,4,7,4,2,5,7,5,2,6,7,6,2,7,7,7,2,8,7,8,1,0,5,0,20,
	8,0,10,0,12,0,23,9,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,1,32,8,1,1,2,1,2,1,3,
	1,3,1,4,1,4,1,5,1,5,1,6,1,6,1,7,1,7,1,8,1,8,1,8,0,0,9,0,2,4,6,8,10,12,14,
	16,0,0,45,0,21,1,0,0,0,2,31,1,0,0,0,4,33,1,0,0,0,6,35,1,0,0,0,8,37,1,0,
	0,0,10,39,1,0,0,0,12,41,1,0,0,0,14,43,1,0,0,0,16,45,1,0,0,0,18,20,3,2,1,
	0,19,18,1,0,0,0,20,23,1,0,0,0,21,19,1,0,0,0,21,22,1,0,0,0,22,1,1,0,0,0,
	23,21,1,0,0,0,24,32,3,4,2,0,25,32,3,6,3,0,26,32,3,8,4,0,27,32,3,10,5,0,
	28,32,3,12,6,0,29,32,3,14,7,0,30,32,3,16,8,0,31,24,1,0,0,0,31,25,1,0,0,
	0,31,26,1,0,0,0,31,27,1,0,0,0,31,28,1,0,0,0,31,29,1,0,0,0,31,30,1,0,0,0,
	32,3,1,0,0,0,33,34,5,3,0,0,34,5,1,0,0,0,35,36,5,6,0,0,36,7,1,0,0,0,37,38,
	5,8,0,0,38,9,1,0,0,0,39,40,5,10,0,0,40,11,1,0,0,0,41,42,5,9,0,0,42,13,1,
	0,0,0,43,44,5,1,0,0,44,15,1,0,0,0,45,46,5,2,0,0,46,17,1,0,0,0,2,21,31];

	private static __ATN: ATN;
	public static get _ATN(): ATN {
		if (!JpwabcParser.__ATN) {
			JpwabcParser.__ATN = new ATNDeserializer().deserialize(JpwabcParser._serializedATN);
		}

		return JpwabcParser.__ATN;
	}


	static DecisionsToDFA = JpwabcParser._ATN.decisionToState.map( (ds: DecisionState, index: number) => new DFA(ds, index) );

}

export class VoiceContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public entry_list(): EntryContext[] {
		return this.getTypedRuleContexts(EntryContext) as EntryContext[];
	}
	public entry(i: number): EntryContext {
		return this.getTypedRuleContext(EntryContext, i) as EntryContext;
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_voice;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterVoice) {
	 		listener.enterVoice(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitVoice) {
	 		listener.exitVoice(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitVoice) {
			return visitor.visitVoice(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class EntryContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public note(): NoteContext {
		return this.getTypedRuleContext(NoteContext, 0) as NoteContext;
	}
	public barline(): BarlineContext {
		return this.getTypedRuleContext(BarlineContext, 0) as BarlineContext;
	}
	public linebreak(): LinebreakContext {
		return this.getTypedRuleContext(LinebreakContext, 0) as LinebreakContext;
	}
	public text(): TextContext {
		return this.getTypedRuleContext(TextContext, 0) as TextContext;
	}
	public timesig(): TimesigContext {
		return this.getTypedRuleContext(TimesigContext, 0) as TimesigContext;
	}
	public prelude_beg(): Prelude_begContext {
		return this.getTypedRuleContext(Prelude_begContext, 0) as Prelude_begContext;
	}
	public prelude_end(): Prelude_endContext {
		return this.getTypedRuleContext(Prelude_endContext, 0) as Prelude_endContext;
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_entry;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterEntry) {
	 		listener.enterEntry(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitEntry) {
	 		listener.exitEntry(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitEntry) {
			return visitor.visitEntry(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class NoteContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public Note(): TerminalNode {
		return this.getToken(JpwabcParser.Note, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_note;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterNote) {
	 		listener.enterNote(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitNote) {
	 		listener.exitNote(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitNote) {
			return visitor.visitNote(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class BarlineContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public Barline(): TerminalNode {
		return this.getToken(JpwabcParser.Barline, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_barline;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterBarline) {
	 		listener.enterBarline(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitBarline) {
	 		listener.exitBarline(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitBarline) {
			return visitor.visitBarline(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class LinebreakContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public Return(): TerminalNode {
		return this.getToken(JpwabcParser.Return, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_linebreak;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterLinebreak) {
	 		listener.enterLinebreak(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitLinebreak) {
	 		listener.exitLinebreak(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitLinebreak) {
			return visitor.visitLinebreak(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TextContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public STRING(): TerminalNode {
		return this.getToken(JpwabcParser.STRING, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_text;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterText) {
	 		listener.enterText(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitText) {
	 		listener.exitText(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitText) {
			return visitor.visitText(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TimesigContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public TimeSig(): TerminalNode {
		return this.getToken(JpwabcParser.TimeSig, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_timesig;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterTimesig) {
	 		listener.enterTimesig(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitTimesig) {
	 		listener.exitTimesig(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitTimesig) {
			return visitor.visitTimesig(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class Prelude_begContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public Prelude_beg(): TerminalNode {
		return this.getToken(JpwabcParser.Prelude_beg, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_prelude_beg;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterPrelude_beg) {
	 		listener.enterPrelude_beg(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitPrelude_beg) {
	 		listener.exitPrelude_beg(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitPrelude_beg) {
			return visitor.visitPrelude_beg(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class Prelude_endContext extends ParserRuleContext {
	constructor(parser?: JpwabcParser, parent?: ParserRuleContext, invokingState?: number) {
		super(parent, invokingState);
    	this.parser = parser;
	}
	public Prelude_end(): TerminalNode {
		return this.getToken(JpwabcParser.Prelude_end, 0);
	}
    public get ruleIndex(): number {
    	return JpwabcParser.RULE_prelude_end;
	}
	public enterRule(listener: JpwabcListener): void {
	    if(listener.enterPrelude_end) {
	 		listener.enterPrelude_end(this);
		}
	}
	public exitRule(listener: JpwabcListener): void {
	    if(listener.exitPrelude_end) {
	 		listener.exitPrelude_end(this);
		}
	}
	// @Override
	public accept<Result>(visitor: JpwabcVisitor<Result>): Result {
		if (visitor.visitPrelude_end) {
			return visitor.visitPrelude_end(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
